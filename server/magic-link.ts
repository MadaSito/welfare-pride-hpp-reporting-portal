import { Router, type Response } from "express";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";
import { db, findUserByEmail, findUserById, type DbUser } from "./repository";
import { attachSession, hashIp, type AuthenticatedRequest } from "./security";
import { sendEmail } from "./email";
import { recordAudit } from "./audit";

const TTL_MS = 10 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ACTIVE_LINKS = 500;
const COOKIE = "wp_magic_browser";
const COOKIE_PATH = "/api/v1/auth/magic-link";
const validToken = /^[A-Za-z0-9_-]{43}$/;
const emailSchema = z.string().trim().max(254).email();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

// No host or forwarded header is ever used to build a link. HTTP is for isolated tests only.
function appOrigin(): string | null {
  const value = process.env.APP_ORIGIN;
  try {
    if (process.env.NODE_ENV === "production" && (process.env.APP_SESSION_SECRET?.length ?? 0) < 32) return null;
    if (!value) return null;
    const parsed = new URL(value);
    if (parsed.origin !== value || parsed.username || parsed.password) return null;
    if (parsed.protocol === "https:") return value;
    if (process.env.NODE_ENV === "test" && parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return value;
  } catch { /* invalid configuration */ }
  return null;
}

function limitKey(value: string): string {
  // Keyed account identifiers avoid keeping guessable email hashes in the database.
  return createHmac("sha256", process.env.APP_SESSION_SECRET || "development-only-session-secret-min32ch!!").update(value).digest("hex");
}

// Check every ceiling before incrementing any bucket. Denied IP/account requests
// cannot exhaust the global bucket or create unbounded per-address rows.
const takeLimit = db.transaction((kind: "request" | "consume", ip: string, email: string) => {
  const now = Date.now();
  db.prepare("DELETE FROM magic_link_limits WHERE expires_at <= ?").run(now);
  if (kind === "request") db.prepare("DELETE FROM magic_links WHERE expires_at <= ?").run(now);
  const buckets: Array<[string, number]> = [
    [`${kind}:ip:${limitKey(ip)}`, kind === "request" ? 20 : 60],
    ...(kind === "request" ? [[`request:account:${limitKey(email.toLowerCase())}`, 3] as [string, number]] : []),
    [`${kind}:global`, kind === "request" ? 500 : 3000],
  ];
  for (const [key, maximum] of buckets) {
    const row = db.prepare("SELECT count FROM magic_link_limits WHERE key = ?").get(key) as { count: number } | undefined;
    if (row && row.count >= maximum) return false;
  }
  for (const [key] of buckets) {
    db.prepare("INSERT INTO magic_link_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1")
      .run(key, now + WINDOW_MS);
  }
  return true;
});

function allowedRequest(req: AuthenticatedRequest, origin: string | null): boolean {
  return !!origin && req.get("origin") === origin && !!req.is("application/json");
}
function browserCookie(req: AuthenticatedRequest): string | null {
  const parts = (req.headers.cookie || "").split(";").map(v => v.trim());
  const matching = parts.filter(v => v.startsWith(`${COOKIE}=`));
  if (matching.length !== 1) return null;
  const value = matching[0].slice(COOKIE.length + 1);
  return validToken.test(value) ? value : null;
}
function ambiguousBrowserCookie(req: AuthenticatedRequest): boolean {
  const matching = (req.headers.cookie || "").split(";").map(v => v.trim()).filter(v => v.startsWith(`${COOKIE}=`));
  // Never replace a potentially valid binding when duplicate cookie names make
  // its identity ambiguous; consumption similarly fails closed in this case.
  return matching.length > 1 && matching.some(v => validToken.test(v.slice(COOKIE.length + 1)));
}
function cookieOptions(origin: string) {
  return { httpOnly: true, secure: origin.startsWith("https:"), sameSite: "lax" as const, path: COOKIE_PATH };
}

// Fail closed for locked accounts, stale MFA, first-password-change and non-local users.
const eligibleSql = `status = 'active' AND auth_provider = 'local' AND password_hash IS NOT NULL
  AND must_change_password = 0 AND mfa_required = 1 AND mfa_enrolled_at IS NOT NULL
  AND mfa_secret_encrypted IS NOT NULL AND mfa_secret_encrypted != ''
  AND (locked_until IS NULL OR julianday(locked_until) <= julianday('now'))`;

function safeIp(req: AuthenticatedRequest): string {
  // Reverse proxies must enforce an additional authenticated client-IP limit at the edge.
  return ipKeyGenerator(req.socket.remoteAddress || "0.0.0.0");
}

type MagicAuditAction = "auth.magic_link.requested" | "auth.magic_link.consume_succeeded" | "auth.magic_link.consume_failed";

// Deliberately exclude body, cookies, email, user-agent and untrusted forwarding
// headers. A fresh ID avoids copying a client-supplied request ID into events.
function auditMagicLink(req: AuthenticatedRequest, action: MagicAuditAction, statusCode: number, user?: DbUser) {
  return recordAudit({
    requestId: randomUUID(),
    action,
    severity: statusCode >= 400 ? "warning" : "info",
    resourceType: "user",
    resourceId: user?.id ?? null,
    actorId: user?.id ?? null,
    actorRole: user?.role ?? null,
    tenantId: user?.tenant_id ?? null,
    ipHash: hashIp(safeIp(req)),
    method: "POST",
    statusCode,
  });
}

// Request audits must have the same timing regardless of account existence,
// and audit errors must not leak provider/database messages or affect responses.
export function scheduleMagicLinkAudit(req: AuthenticatedRequest, action: MagicAuditAction, statusCode: number) {
  setImmediate(() => {
    try { void auditMagicLink(req, action, statusCode).catch(() => {}); } catch { /* best effort */ }
  });
}

const createPendingLink = db.transaction((user: DbUser, tokenHash: string, browserHash: string, now: number) => {
  db.prepare("DELETE FROM magic_links WHERE expires_at <= ?").run(now);
  // Keep every unexpired pending link, including same-browser retries: replacing
  // it before mail succeeds could invalidate a link already in the inbox.
  return db.prepare(`INSERT INTO magic_links(user_id,token_hash,browser_hash,session_version,tenant_id,email,expires_at)
    SELECT id, ?, ?, session_version, tenant_id, email, ? FROM users
    WHERE id = ? AND email = ? AND ${eligibleSql} AND (SELECT count(*) FROM magic_links) < ?
    ON CONFLICT(user_id) DO NOTHING`)
    .run(tokenHash, browserHash, now + TTL_MS, user.id, user.email, MAX_ACTIVE_LINKS).changes === 1;
});

async function deliver(email: string, binding: string, origin: string): Promise<void> {
  const user = findUserByEmail(email);
  if (!user || !emailSchema.safeParse(user.email).success) return;
  const token = randomBytes(32).toString("base64url");
  const tokenHash = digest(token);
  const now = Date.now();
  // Eligibility and capacity are checked atomically with insertion.
  if (!createPendingLink(user, tokenHash, digest(binding), now)) return;
  try {
    const link = `${origin}/magic-link#token=${token}`;
    const result = await sendEmail({ to: user.email, subject: "Your sign-in link",
      text: `Use this link in the same browser where you requested it. It expires in 10 minutes.\n\n${link}\n\nYou will also need your MFA code. If you did not request this link, ignore this email.`,
      sensitive: true, requireNoBcc: true });
    // Simulation or failure must not leave a usable credential behind. A later
    // request may already have replaced it, so delete only this exact digest.
    if (!result.ok || result.status !== "sent") db.prepare("DELETE FROM magic_links WHERE token_hash = ?").run(tokenHash);
  } catch {
    db.prepare("DELETE FROM magic_links WHERE token_hash = ?").run(tokenHash);
  }
}

const consume = db.transaction((tokenHash: string, browserHash: string): DbUser | null => {
  const row = db.prepare(`SELECT m.user_id FROM magic_links m JOIN users u ON u.id=m.user_id
    WHERE m.token_hash=? AND m.browser_hash=? AND m.expires_at > ?
      AND m.session_version=u.session_version AND m.tenant_id IS u.tenant_id AND m.email=u.email
      AND ${eligibleSql.replaceAll(/\b(status|auth_provider|password_hash|must_change_password|mfa_required|mfa_enrolled_at|mfa_secret_encrypted|locked_until)\b/g, "u.$1")}`)
    .get(tokenHash, browserHash, Date.now()) as { user_id: string } | undefined;
  if (!row) return null;
  if (db.prepare("DELETE FROM magic_links WHERE token_hash = ? AND browser_hash = ?").run(tokenHash, browserHash).changes !== 1) return null;
  return findUserById(row.user_id);
});

export function magicLinkRouter(issueSession: (user: DbUser, stage: "mfa_verify", csrf: string, ttl: string) => Promise<string>) {
  const router = Router();
  router.post("/request", (req: AuthenticatedRequest, res: Response) => {
    const origin = appOrigin();
    if (!allowedRequest(req, origin)) {
      scheduleMagicLinkAudit(req, "auth.magic_link.requested", 403);
      return res.status(403).json({ error: "ORIGIN_REJECTED" });
    }
    const email = emailSchema.safeParse(req.body?.email);
    const ambiguous = ambiguousBrowserCookie(req);
    const binding = browserCookie(req) || (ambiguous ? null : randomBytes(32).toString("base64url"));
    if (binding) res.cookie(COOKIE, binding, { ...cookieOptions(origin!), maxAge: TTL_MS });
    let permitted = false;
    try { permitted = takeLimit("request", safeIp(req), email.success ? email.data : "invalid"); } catch { /* fail closed */ }
    // Same response, cookie, and pre-response work for unknown, ineligible, throttled,
    // disabled mail and eligible accounts. Dispatch is never awaited by the client.
    res.status(202).json({ ok: true });
    scheduleMagicLinkAudit(req, "auth.magic_link.requested", 202);
    if (permitted && email.success && !req.session && binding) {
      setImmediate(() => { void deliver(email.data, binding, origin!).catch(() => { /* no credentials or provider errors in logs */ }); });
    }
  });

  router.post("/consume", async (req: AuthenticatedRequest, res: Response) => {
    const origin = appOrigin();
    if (!allowedRequest(req, origin)) {
      scheduleMagicLinkAudit(req, "auth.magic_link.consume_failed", 403);
      return res.status(403).json({ error: "ORIGIN_REJECTED" });
    }
    const reject = () => {
      scheduleMagicLinkAudit(req, "auth.magic_link.consume_failed", 401);
      return res.status(401).json({ error: "INVALID_MAGIC_LINK" });
    };
    if (req.session) return reject(); // Never replace an existing authenticated or pending session.
    let permitted = false;
    try { permitted = takeLimit("consume", safeIp(req), ""); } catch { return reject(); }
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const binding = browserCookie(req);
    if (!permitted || !validToken.test(token) || !binding) return reject();
    let user: DbUser | null;
    try { user = consume(digest(token), digest(binding)); } catch { return reject(); }
    if (!user) return reject();
    const csrf = randomBytes(24).toString("base64url");
    let session: string;
    try { session = await issueSession(user, "mfa_verify", csrf, "10m"); } catch { return reject(); }
    const accountUnchanged = () => {
      const current = findUserById(user.id);
      const stillEligible = db.prepare(`SELECT 1 FROM users WHERE id=? AND ${eligibleSql}`).get(user.id);
      return !!stillEligible && !!current && current.session_version === user.session_version && current.tenant_id === user.tenant_id &&
        current.role === user.role && current.email === user.email && current.mfa_secret_encrypted === user.mfa_secret_encrypted;
    };
    try { if (!accountUnchanged()) return reject(); } catch { return reject(); }
    // Do not attach even a pending session if auditing fails. The event identifies
    // the account without recording its address, token, binding, or session.
    try { await auditMagicLink(req, "auth.magic_link.consume_succeeded", 200, user); } catch { return reject(); }
    // Signing and auditing are asynchronous: recheck immediately before attaching.
    try { if (!accountUnchanged()) return reject(); } catch { return reject(); }
    res.clearCookie(COOKIE, cookieOptions(origin!));
    attachSession(res, session, req);
    return res.json({ stage: "mfa_verify", userId: user.id, csrf });
  });
  return router;
}
