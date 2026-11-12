import express from "express";
import helmet from "helmet";
import multer from "multer";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { TOTP, Secret } from "otpauth";
import { decodeJwt, SignJWT } from "jose";
import { z } from "zod";
import Papa from "papaparse";

import {
  ROLES,
  COMPROMISED_LEGACY_PASSWORDS,
  canonicalRole,
  type Role,
  type AuthenticatedRequest,
  sessionMiddleware,
  requireSession,
  requireRole,
  verifyCsrf,
  createSession,
  attachSession,
  clearSession,
  validatePassword,
  hashPassword,
  verifyPassword,
  encryptSecret,
  decryptSecret,
  mayAssignRole,
  canManageTarget,
  generateRecoveryCodes,
  hashRecoveryCode,
} from "./security";
import {
  runMigrations,
  quarantineLegacyCredentials,
  findUserByEmail,
  findUserById,
  listUsers,
  createUser,
  updateUser,
  disableUser,
  enableUser,
  revokeSessions,
  changePasswordForSession,
  completeRequiredPasswordChange,
  markSignInFailure,
  markSignInSuccess,
  setMfaSecret,
  setMfaRecoveryCodes,
  consumeMfaRecoveryCode,
  resetUserMfa,
  createInvitation,
  findInvitation,
  consumeInvitation,
  createPasswordReset,
  findPasswordReset,
  consumePasswordReset,
  listMonthlyMetrics,
  findMonthlyMetric,
  upsertMonthlyMetric,
  listAvailableYears,
  computeKpis,
  listReports,
  findReport,
  createReport,
  updateReport,
  db,
  publishReport,
  hideReport,
  deleteReport,
  getReportAssignments,
  listAuditEvents,
  listMailLogs,
  getEmailConfig,
  updateEmailConfig,
  getSiemConfig,
  updateSiemConfig,
  getEntraConfig,
  updateEntraConfig,
  getBrandConfig,
  updateBrandConfig,
  listIpRules,
  addIpRule,
  deleteIpRule,
  type DbUser,
} from "./repository";
import { recordAudit } from "./audit";
import { requestLogging, writeLog } from "./logging";
import { edgeInfoMiddleware, ipFirewallMiddleware, createLimiters } from "./cloudflare";
import { dispatchToSiem, flushSiemBuffer, testSiem } from "./siem";
import { sendEmail, resendMailLog, emailCircuitStatus } from "./email";
import { canAccessReport, canReceiveReport, eligibleRecipients, executiveReport, renderExecutivePdf } from "./executive-report";
import {
  exportJsonConfig,
  importJsonConfig,
  backupFilePath,
  listBackups,
  deleteBackupRecord,
} from "./backup";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const upload = multer({ limits: { fileSize: 100 * 1024 * 1024 } });
function param(v: unknown): string { return Array.isArray(v) ? String(v[0] ?? "") : String(v ?? ""); }
 // 100 MB for backup archives / uploads

const app = express();
app.set("trust proxy", true); // parse CF-Connecting-IP / X-Forwarded-For

const limiters = createLimiters();
const reportLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.REPORT_RATELIMIT_MAX || 60),
  standardHeaders: true,
  legacyHeaders: false,
  // Socket address cannot be forged with forwarding headers. Reverse-proxy
  // clients share a bucket unless an authenticated edge limiter is configured.
  keyGenerator: req => ipKeyGenerator(req.socket.remoteAddress || "0.0.0.0"),
  message: { error: "REPORT_RATE_LIMIT_EXCEEDED" },
});

// ---------------------------------------------------------------------
// Middleware stack (zero-trust, security headers, rate limiting)
// ---------------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Tailwind inline styles
        fontSrc: ["'self'", "data:"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  }),
);
// Set before parsers, rate limiters and CSRF so even rejected auth responses are not cached.
app.use(["/api/v1/auth", "/api/v1/admin/invitations", "/api/v1/reports", "/api/v1/admin/reports", "/api/v1/metrics", "/api/v1/dashboard", "/api/v1/admin/audit", "/api/v1/admin/mail-logs"], (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use("/api/v1/admin/users", (req, res, next) => {
  if (req.method === "POST" && req.path === "/") res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "5mb" }));
app.use(edgeInfoMiddleware);
app.use(requestLogging);
app.use(ipFirewallMiddleware);
app.use(limiters.standard);
app.use(["/api/v1/reports", "/api/v1/admin/reports"], reportLimiter);
app.use(sessionMiddleware);
// JWTs are not authoritative: consult live account state for every request.
app.use((req: AuthenticatedRequest, _res, next) => {
  if (req.session) {
    const user = findUserById(req.session.sub);
    // sessionMiddleware has verified this exact cookie's signature before we inspect
    // the additional claims, which its public SessionClaims type does not expose.
    const cookieName = process.env.SESSION_COOKIE_NAME || "wp_session";
    const token = req.headers.cookie?.split(";").map(item => item.trim()).find(item => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    let authProvider: unknown;
    let status: unknown;
    let role: unknown;
    let tenantId: unknown;
    try { const payload = decodeJwt(token || ""); authProvider = payload.authProvider; status = payload.status; role = payload.role; tenantId = payload.tenantId; } catch { /* reject below */ }
    if (!user || user.auth_provider !== "local" || authProvider !== user.auth_provider ||
        status !== user.status || !["active", "invited"].includes(user.status) ||
        role !== user.role || tenantId !== user.tenant_id || req.session.role !== user.role || req.session.tenantId !== user.tenant_id ||
        req.session.sessionVersion !== user.session_version ||
        (req.session.stage === "full" && (user.status !== "active" || user.must_change_password || !user.mfa_enrolled_at || !user.mfa_secret_encrypted))) {
      req.session = undefined;
    }
  }
  next();
});
app.use(verifyCsrf);

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
// Add the account snapshot to the JWT issued by the shared session helper.
// Old JWTs without these claims are deliberately rejected by the middleware.
async function issueSession(user: DbUser, stage: "full" | "mfa_verify" | "mfa_enroll" | "password_change", csrf: string, ttl: string): Promise<string> {
  const base = await createSession({ sub: user.id, role: user.role, tenantId: user.tenant_id, stage,
    displayName: user.display_name, email: user.email, sessionVersion: user.session_version, csrf }, ttl);
  const configured = process.env.APP_SESSION_SECRET;
  // createSession already enforces the production secret policy.
  const key = new TextEncoder().encode(configured && configured.length >= 32 ? configured : "development-only-session-secret-min32ch!!");
  return new SignJWT({ ...decodeJwt(base), authProvider: user.auth_provider, status: user.status })
    .setProtectedHeader({ alg: "HS256" }).sign(key);
}

function actorInfo(req: AuthenticatedRequest) {
  return {
    actorId: req.session?.sub ?? null,
    actorRole: req.session?.role,
    actorEmail: req.session?.email ?? null,
    tenantId: req.session?.tenantId ?? null,
    realIp: req.realIp,
    geoCountry: req.geoCountry,
  };
}

async function audit(
  req: AuthenticatedRequest,
  action: string,
  statusCode: number,
  resourceType: string,
  resourceId?: string | null,
  metadata?: object,
  extra?: { severity?: "info" | "warning" | "critical"; beforeState?: object | null; afterState?: object | null },
): Promise<string> {
  const info = actorInfo(req);
  return recordAudit({
    requestId: req.requestId ?? "unknown",
    ...info,
    action,
    severity: extra?.severity ?? (statusCode >= 500 ? "critical" : statusCode >= 400 ? "warning" : "info"),
    resourceType,
    resourceId: resourceId ?? null,
    ipHash: req.ipHash || "unknown",
    userAgent: req.header("user-agent") ?? null,
    method: req.method,
    statusCode,
    beforeState: extra?.beforeState,
    afterState: extra?.afterState,
    metadata,
  });
}

function sanitizeUser(u: { password_hash?: unknown; mfa_secret_encrypted?: unknown; mfa_recovery_codes?: unknown; [k: string]: unknown }) {
  const { password_hash, mfa_secret_encrypted, mfa_recovery_codes, session_version, ...rest } = u;
  return rest;
}

// ---------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------
app.get("/api/v1/health", (_req, res) => {
  res.json({
    status: "ok",
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    database: "sqlite",
  });
});

// ---------------------------------------------------------------------
// Public branding endpoint (for the UI to render themes & logos)
// ---------------------------------------------------------------------
app.get("/api/v1/branding", (_req, res) => {
  res.json(getBrandConfig());
});

// ---------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

app.post("/api/v1/auth/login", limiters.authStrict, async (req: AuthenticatedRequest, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_CREDENTIALS_PAYLOAD" });
  const user = findUserByEmail(parsed.data.email);

  if (!user || !user.password_hash || user.auth_provider !== "local") {
    await audit(req, "auth.login.failed", 401, "user", null, { reason: "unknown_user" });
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }

  if (user.status === "disabled") {
    await audit(req, "auth.login.blocked", 403, "user", user.id, { reason: "disabled" });
    return res.status(403).json({ error: "ACCOUNT_DISABLED" });
  }

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    await audit(req, "auth.login.locked", 423, "user", user.id, { lockedUntil: user.locked_until });
    return res.status(423).json({ error: "ACCOUNT_LOCKED", retryAfter: user.locked_until });
  }

  const ok = await verifyPassword(user.password_hash, parsed.data.password);
  if (!ok) {
    markSignInFailure(user.id);
    await audit(req, "auth.login.failed", 401, "user", user.id, { reason: "bad_password" });
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }

  // Password verification is asynchronous: refuse to authenticate an account
  // whose security state changed while the password was being checked.
  const current = findUserById(user.id);
  if (!current || current.status === "disabled" || current.password_hash !== user.password_hash ||
      current.session_version !== user.session_version || current.role !== user.role ||
      current.tenant_id !== user.tenant_id || current.auth_provider !== "local" || current.status !== user.status) {
    return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
  }
  markSignInSuccess(user.id);
  const signedIn = findUserById(user.id)!;

  // Local sign-in always requires MFA, including migrated accounts formerly marked optional.
  const stage = signedIn.mfa_enrolled_at && signedIn.mfa_secret_encrypted ? "mfa_verify" : "mfa_enroll";
  const csrf = randomBytes(24).toString("base64url");
  const pendingSession = await issueSession(signedIn, stage, csrf, "10m");
  attachSession(res, pendingSession, req);
  await audit(req, stage === "mfa_enroll" ? "auth.mfa.enrollment_required" : "auth.mfa.challenge_issued", 200, "user", user.id);
  return res.json({ stage, userId: user.id, csrf });
});

app.post("/api/v1/auth/mfa/enroll", async (req: AuthenticatedRequest, res) => {
  const session = req.session;
  if (!session || session.stage !== "mfa_enroll") {
    return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
  }
  const user = findUserById(session.sub);
  if (!user) return res.status(404).json({ error: "USER_NOT_FOUND" });
  if (user.mfa_enrolled_at) return res.status(409).json({ error: "MFA_ALREADY_ENROLLED" });

  const secret = new Secret({ size: 20 });
  const totp = new TOTP({
    issuer: "Welfare Pride HPP",
    label: user.email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret,
  });
  const encrypted = encryptSecret(secret.base32);
  setMfaSecret(user.id, encrypted);
  await audit(req, "auth.mfa.enrollment.started", 200, "user", user.id);
  res.json({ uri: totp.toString(), manualSecret: secret.base32 });
});

app.post("/api/v1/auth/mfa/verify", limiters.authStrict, async (req: AuthenticatedRequest, res) => {
  const session = req.session;
  if (!session || !["mfa_verify", "mfa_enroll"].includes(session.stage)) {
    return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
  }
  const code = String(req.body?.code ?? "").trim();
  const recoveryCode = String(req.body?.recoveryCode ?? "").trim();
  const user = findUserById(session.sub);
  if (!user || !user.mfa_secret_encrypted) return res.status(400).json({ error: "MFA_NOT_CONFIGURED" });
  if ((session.stage === "mfa_enroll" && user.mfa_enrolled_at) || (session.stage === "mfa_verify" && !user.mfa_enrolled_at)) return res.status(409).json({ error: "MFA_STAGE_INVALID" });

  let ok = false;
  let usedRecovery = false;
  try {
    const base32 = decryptSecret(user.mfa_secret_encrypted);
    const totp = new TOTP({ secret: Secret.fromBase32(base32), digits: 6, period: 30 });
    ok = !recoveryCode && totp.validate({ token: code, window: 1 }) !== null;
  } catch {
    ok = false;
  }

  if (!ok && recoveryCode) {
    ok = consumeMfaRecoveryCode(user.id, hashRecoveryCode(recoveryCode));
    usedRecovery = ok;
  }

  if (!ok) {
    await audit(req, "auth.mfa.failed", 401, "user", user.id);
    return res.status(401).json({ error: "INVALID_MFA_CODE" });
  }

  let recoveryCodes: string[] | undefined;
  if (session.stage === "mfa_enroll") {
    // Issue recovery codes on first enrollment
    const codes = generateRecoveryCodes(8);
    setMfaRecoveryCodes(user.id, JSON.stringify(codes.map(hashRecoveryCode)));
    recoveryCodes = codes;
  }

  const updated = findUserById(user.id)!;
  const stage = updated.must_change_password ? "password_change" : "full";
  const csrf = randomBytes(24).toString("base64url");
  const token = await issueSession(updated, stage, csrf, stage === "full" ? "30m" : "10m");
  attachSession(res, token, req);
  await audit(req, usedRecovery ? "auth.mfa.recovery_used" : "auth.mfa.succeeded", 200, "user", user.id);
  res.json({ ok: true, stage, userId: user.id, user: stage === "full" ? sanitizeUser(findUserById(user.id)!) : undefined, recoveryCodes, csrf });
});

app.get("/api/v1/auth/session", async (req: AuthenticatedRequest, res) => {
  if (!req.session) return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
  if (req.session.stage !== "full") {
    return res.json({ stage: req.session.stage, userId: req.session.sub, csrf: req.session.csrf });
  }
  const user = findUserById(req.session.sub);
  if (!user) return res.status(404).json({ error: "USER_NOT_FOUND" });
  res.json({ stage: "full", user: sanitizeUser(user), csrf: req.session.csrf });
});

app.post("/api/v1/auth/logout", async (req: AuthenticatedRequest, res) => {
  if (!req.session) return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
  const actor = actorInfo(req);
  const session = req.session;
  const revoked = session.sessionVersion !== undefined && revokeSessions(session.sub, session.sessionVersion);
  clearSession(res, req);
  if (!revoked) return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
  await recordAudit({
    requestId: req.requestId ?? "unknown",
    ...actor,
    action: "auth.logout",
    severity: "info",
    resourceType: "user",
    resourceId: session.sub,
    ipHash: req.ipHash || "unknown",
    userAgent: req.header("user-agent") ?? null,
    method: "POST",
    statusCode: 200,
  });
  res.json({ ok: true });
});

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(14).max(128),
});
app.post("/api/v1/auth/password", limiters.authStrict, async (req: AuthenticatedRequest, res) => {
  const session = req.session;
  if (!session || !["full", "password_change"].includes(session.stage)) return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
  const parsed = passwordChangeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_PAYLOAD" });
  if (!validatePassword(parsed.data.newPassword)) return res.status(400).json({ error: "PASSWORD_POLICY_VIOLATION" });
  const user = findUserById(session.sub);
  if (!user || !user.password_hash) return res.status(404).json({ error: "USER_NOT_FOUND" });
  if (!(await verifyPassword(user.password_hash, parsed.data.currentPassword))) {
    await audit(req, "auth.password.change.failed", 401, "user", user.id);
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }
  if (await verifyPassword(user.password_hash, parsed.data.newPassword)) return res.status(400).json({ error: "PASSWORD_MUST_DIFFER" });
  const hash = await hashPassword(parsed.data.newPassword);
  if (session.sessionVersion === undefined) return res.status(409).json({ error: "SESSION_EXPIRED" });
  if (session.stage === "password_change") {
    if (!completeRequiredPasswordChange(user.id, session.sessionVersion, user.password_hash, hash)) return res.status(409).json({ error: "SESSION_EXPIRED" });
  } else {
    if (!changePasswordForSession(user.id, session.sessionVersion, user.password_hash, hash)) return res.status(409).json({ error: "SESSION_EXPIRED" });
  }
  const updated = findUserById(user.id)!;
  const csrf = randomBytes(24).toString("base64url");
  const token = await issueSession(updated, "full", csrf, "30m");
  attachSession(res, token, req);
  await audit(req, "auth.password.changed", 200, "user", user.id);
  res.json({ ok: true, stage: "full", user: sanitizeUser(updated), csrf });
});

// Disabled until reset token delivery, mail log redaction, and account lifecycle are secured.
app.post(["/api/v1/auth/forgot", "/api/v1/auth/forgot-password", "/api/v1/auth/reset"], (_req, res) => res.status(501).json({ error: "PASSWORD_RESET_UNAVAILABLE" }));

// ---------------------------------------------------------------------
// User administration (Module 1 — 4-tier RBAC + Super Admin isolation)
// ---------------------------------------------------------------------
app.get("/api/v1/admin/users", requireSession, requireRole("super_admin", "admin"), async (req: AuthenticatedRequest, res) => {
  const actor = req.session!.role;
  const tenant = actor === "admin" ? req.session!.tenantId : null;
  const users = listUsers(actor, tenant).map(sanitizeUser);
  await audit(req, "user.list.viewed", 200, "user", null, { count: users.length });
  res.json({ users });
});

const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(2).max(120),
  role: z.enum(ROLES),
  tenantId: z.string().nullable().optional(),
  mfaRequired: z.boolean().optional(),
});
app.post("/api/v1/admin/users", requireSession, requireRole("super_admin", "admin"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_USER_REQUEST" });
  const actorRole = req.session!.role;
  if (!mayAssignRole(actorRole, parsed.data.role)) {
    await audit(req, "user.creation.denied", 403, "user", null, { requestedRole: parsed.data.role });
    return res.status(403).json({ error: "ROLE_SCOPE_VIOLATION" });
  }
  if (parsed.data.mfaRequired === false) return res.status(400).json({ error: "MFA_REQUIRED" });
  const tenantId = actorRole === "admin" ? req.session!.tenantId : parsed.data.tenantId ?? req.session!.tenantId ?? null;
  const tempPassword = randomBytes(16).toString("base64url") + "A1!a";
  const passwordHash = await hashPassword(tempPassword);
  try {
    const id = createUser({
      tenantId,
      email: parsed.data.email,
      displayName: parsed.data.displayName,
      role: parsed.data.role,
      passwordHash,
      mfaRequired: parsed.data.mfaRequired ?? true,
      status: "invited",
      mustChangePassword: true,
      createdBy: req.session!.sub,
    });
    await audit(req, "user.created", 201, "user", id, { role: parsed.data.role });
    res.status(201).json({
      id,
      temporaryPassword: tempPassword,
      message: "Deliver this temporary password over a verified channel only. MFA enrollment is enforced at first sign-in.",
    });
  } catch (err) {
    if (String(err).includes("UNIQUE")) return res.status(409).json({ error: "EMAIL_ALREADY_EXISTS" });
    throw err;
  }
});

const updateUserSchema = z.object({
  displayName: z.string().min(2).max(120).optional(),
  role: z.enum(ROLES).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  mfaRequired: z.boolean().optional(),
});
app.patch("/api/v1/admin/users/:id", requireSession, requireRole("super_admin", "admin"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  const target = findUserById(param(req.params.id));
  if (!target) return res.status(404).json({ error: "USER_NOT_FOUND" });
  const actor = req.session!.role;
  if (!canManageTarget(actor, target.role)) return res.status(403).json({ error: "CANNOT_MANAGE_TARGET" });
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_PAYLOAD" });
  if (parsed.data.mfaRequired === false) return res.status(400).json({ error: "MFA_REQUIRED" });
  if (parsed.data.role && !mayAssignRole(actor, parsed.data.role)) return res.status(403).json({ error: "ROLE_SCOPE_VIOLATION" });
  if (parsed.data.status === "active" && target.status === "disabled" && target.password_hash) {
    for (const exposed of COMPROMISED_LEGACY_PASSWORDS) {
      if (await verifyPassword(target.password_hash, exposed)) return res.status(409).json({ error: "COMPROMISED_CREDENTIAL_RESET_REQUIRED" });
    }
  }
  if (parsed.data.status === "disabled") disableUser(target.id);
  else if (parsed.data.status === "active") enableUser(target.id);
  updateUser(target.id, { displayName: parsed.data.displayName, role: parsed.data.role, mfaRequired: parsed.data.mfaRequired });
  await audit(req, "user.updated", 200, "user", target.id, parsed.data);
  res.json({ ok: true, user: sanitizeUser(findUserById(target.id)!) });
});

app.post("/api/v1/admin/users/:id/reset-mfa", requireSession, requireRole("super_admin", "admin"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  const target = findUserById(param(req.params.id));
  if (!target) return res.status(404).json({ error: "USER_NOT_FOUND" });
  if (!canManageTarget(req.session!.role, target.role)) return res.status(403).json({ error: "CANNOT_MANAGE_TARGET" });
  resetUserMfa(target.id);
  await audit(req, "user.mfa.reset", 200, "user", target.id);
  res.json({ ok: true });
});

// Local <-> Entra ID SSO conversion engine (Module 1)
app.post("/api/v1/admin/users/:id/convert-sso", requireSession, requireRole("super_admin"), (_req, res) => {
  res.status(501).json({ error: "SSO_NOT_AVAILABLE" });
});

// Invitations
app.post("/api/v1/admin/invitations", requireSession, requireRole("super_admin", "admin"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  const email = z.string().email().safeParse(req.body?.email);
  const role = z.enum(ROLES).safeParse(req.body?.role ?? "view_only");
  if (!email.success || !role.success) return res.status(400).json({ error: "INVALID_INVITATION" });
  if (!mayAssignRole(req.session!.role, role.data)) return res.status(403).json({ error: "ROLE_SCOPE_VIOLATION" });
  const inv = createInvitation(email.data, role.data, req.session!.tenantId, req.session!.sub);
  const origin = process.env.APP_ORIGIN || `http://localhost:${process.env.PORT || 3000}`;
  const link = `${origin}/#invite=${inv.token}`;
  await audit(req, "invitation.created", 201, "invitation", inv.id, { email: email.data, role: role.data });
  res.status(201).json({ invitation: inv, link });
});

app.get("/api/v1/admin/invitations/:token", async (req, res) => {
  const inv = findInvitation(param(req.params.token));
  if (!inv) return res.status(404).json({ error: "INVITATION_NOT_FOUND_OR_EXPIRED" });
  res.json({ email: inv.email, role: inv.role });
});

app.post("/api/v1/admin/invitations/:token/accept", limiters.authStrict, async (req: AuthenticatedRequest, res) => {
  const inv = findInvitation(param(req.params.token));
  if (!inv) return res.status(400).json({ error: "INVITATION_NOT_FOUND_OR_EXPIRED" });
  const password = String(req.body?.password || "");
  const displayName = String(req.body?.displayName || inv.email.split("@")[0]);
  if (!validatePassword(password)) return res.status(400).json({ error: "PASSWORD_POLICY_VIOLATION" });
  const passwordHash = await hashPassword(password);
  const id = createUser({
    tenantId: inv.tenant_id,
    email: inv.email,
    displayName,
    role: inv.role,
    passwordHash,
    status: "active",
    mfaRequired: true,
  });
  consumeInvitation(param(req.params.token));
  await audit(req, "invitation.accepted", 200, "user", id);
  res.json({ ok: true, message: "Account created. Sign in to complete MFA enrollment." });
});

// ---------------------------------------------------------------------
// Monthly metrics (Module 3 — the EXACT 9 manual fields + computed KPIs)
// ---------------------------------------------------------------------
const metricsSchema = z.object({
  reporting_month: z.number().int().min(1).max(12),
  reporting_year: z.number().int().min(2000).max(2200),
  calls_round1: z.number().int().min(0),
  calls_round2: z.number().int().min(0),
  calls_round3: z.number().int().min(0),
  aca_yes: z.number().int().min(0),
  aca_no: z.number().int().min(0),
  head_of_household: z.number().int().min(0),
  staff_members: z.number().int().min(0),
  calls_jhpp: z.number().int().min(0),
  calls_wr: z.number().int().min(0),
  notes: z.string().max(2000).optional().nullable(),
});

app.get("/api/v1/metrics", requireSession, requireRole("super_admin", "admin", "manager"), async (req: AuthenticatedRequest, res) => {
  const year = req.query.year ? Number(req.query.year) : undefined;
  const rows = listMonthlyMetrics(year, req.session!.tenantId);
  const data = rows.map(m => ({ ...m, kpis: computeKpis(m) }));
  await audit(req, "metrics.list.viewed", 200, "metrics", null, { count: rows.length, year });
  res.json({ metrics: data, availableYears: listAvailableYears(req.session!.tenantId) });
});

app.get("/api/v1/metrics/years", requireSession, requireRole("super_admin", "admin", "manager"), (req: AuthenticatedRequest, res) => {
  res.json({ years: listAvailableYears(req.session!.tenantId) });
});

app.get("/api/v1/metrics/:year/:month", requireSession, requireRole("super_admin", "admin", "manager"), (req: AuthenticatedRequest, res) => {
  if (!req.session!.tenantId) return res.status(404).json({ error: "NO_METRIC_DATA" });
  const m = findMonthlyMetric(Number(req.params.year), Number(req.params.month), req.session!.tenantId);
  if (!m) return res.status(404).json({ error: "NO_METRIC_DATA" });
  res.json({ ...m, kpis: computeKpis(m) });
});

app.put("/api/v1/metrics/:year/:month", requireSession, requireRole("super_admin", "admin", "manager"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  if (!req.session!.tenantId) return res.status(403).json({ error: "TENANT_REQUIRED" });
  const payload = {
    ...req.body,
    reporting_month: Number(req.params.month),
    reporting_year: Number(req.params.year),
  };
  const parsed = metricsSchema.safeParse(payload);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_METRICS", issues: parsed.error.issues });
  const before = findMonthlyMetric(parsed.data.reporting_year, parsed.data.reporting_month, req.session!.tenantId);
  const row = upsertMonthlyMetric({
    tenantId: req.session!.tenantId,
    ...parsed.data,
    entered_by: req.session!.sub,
  });
  await audit(req, before ? "metrics.updated" : "metrics.created", 200, "metrics", `${parsed.data.reporting_year}-${parsed.data.reporting_month}`, undefined, {
    beforeState: before || undefined,
    afterState: row,
  });
  res.json({ ...row, kpis: computeKpis(row) });
});

app.post("/api/v1/metrics/import", requireSession, requireRole("super_admin", "admin", "manager"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  const csvText = req.body?.csv;
  if (!csvText || typeof csvText !== "string") return res.status(400).json({ error: "CSV_REQUIRED" });
  if (!req.session!.tenantId) return res.status(403).json({ error: "TENANT_REQUIRED" });
  const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: "greedy" });
  const result: { imported: number; errors: { row: number; error: string }[] } = { imported: 0, errors: [] };
  for (let i = 0; i < parsed.data.length; i++) {
    const row = parsed.data[i];
    const fields: Record<string, string> = { reporting_year: "Reporting Year", reporting_month: "Reporting Month", calls_round1: "Calls round 1", calls_round2: "Calls round 2", calls_round3: "Calls round 3", aca_yes: "ACA YES", aca_no: "ACA No", head_of_household: "Head of Household", staff_members: "Staff members making calls", calls_jhpp: "Calls referred to JHPP", calls_wr: "Calls referred to WR" };
    const value: Record<string, unknown> = {};
    for (const [key, header] of Object.entries(fields)) {
      const raw = row[header] ?? row[key];
      value[key] = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
    }
    value.notes = row.Notes ?? row.notes ?? null;
    const metric = metricsSchema.safeParse(value);
    if (!metric.success) { result.errors.push({ row: i + 2, error: "Invalid or missing metric values" }); continue; }
    upsertMonthlyMetric({ tenantId: req.session!.tenantId, ...metric.data, entered_by: req.session!.sub });
    result.imported++;
  }
  for (const e of parsed.errors) result.errors.push({ row: (e.row ?? 0) + 2, error: "Invalid CSV" });
  await audit(req, "metrics.csv.imported", 200, "metrics", null, { imported: result.imported, errors: result.errors.length });
  res.json(result);
});

app.get("/api/v1/metrics/export", requireSession, requireRole("super_admin", "admin", "manager"), async (req: AuthenticatedRequest, res) => {
  const year = req.query.year ? Number(req.query.year) : undefined;
  const rows = listMonthlyMetrics(year, req.session!.tenantId);
  const csv = Papa.unparse({ fields: ["Reporting Year", "Reporting Month", "Calls round 1", "Calls round 2", "Calls round 3", "ACA YES", "ACA No", "Head of Household", "Staff members making calls", "Calls referred to JHPP", "Calls referred to WR", "Notes"], data: rows.map(m => [m.reporting_year,m.reporting_month,m.calls_round1,m.calls_round2,m.calls_round3,m.aca_yes,m.aca_no,m.head_of_household,m.staff_members,m.calls_jhpp,m.calls_wr,m.notes ?? ""]) }, { escapeFormulae: true });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="wp-hpp-metrics-${year || "all"}.csv"`);
  await audit(req, "metrics.csv.exported", 200, "metrics", null, { year });
  res.send(csv);
});

// ---------------------------------------------------------------------
// Dashboard aggregations & trends
// ---------------------------------------------------------------------
app.get("/api/v1/dashboard/summary", requireSession, requireRole("super_admin", "admin", "manager"), (req: AuthenticatedRequest, res) => {
  const year = req.query.year ? Number(req.query.year) : new Date().getUTCFullYear();
  const rows = listMonthlyMetrics(year, req.session!.tenantId);
  const sorted = rows.slice().sort((a, b) => a.reporting_month - b.reporting_month);

  const totals = sorted.reduce(
    (acc, m) => {
      acc.calls_round1 += m.calls_round1;
      acc.calls_round2 += m.calls_round2;
      acc.calls_round3 += m.calls_round3;
      acc.aca_yes += m.aca_yes;
      acc.aca_no += m.aca_no;
      acc.head_of_household += m.head_of_household;
      acc.calls_jhpp += m.calls_jhpp;
      acc.calls_wr += m.calls_wr;
      acc.staff_members = Math.max(acc.staff_members, m.staff_members);
      return acc;
    },
    { calls_round1: 0, calls_round2: 0, calls_round3: 0, aca_yes: 0, aca_no: 0, head_of_household: 0, calls_jhpp: 0, calls_wr: 0, staff_members: 0 },
  );

  const totalCalls = totals.calls_round1 + totals.calls_round2 + totals.calls_round3;
  const totalAca = totals.aca_yes + totals.aca_no;
  const totalReferrals = totals.calls_jhpp + totals.calls_wr;

  const monthlySeries = sorted.map(m => {
    const k = computeKpis(m);
    return {
      month: m.reporting_month,
      year: m.reporting_year,
      round1: m.calls_round1,
      round2: m.calls_round2,
      round3: m.calls_round3,
      totalCalls: k.totalCalls,
      acaYes: m.aca_yes,
      acaNo: m.aca_no,
      acaRate: k.acaRate,
      headOfHousehold: m.head_of_household,
      staff: m.staff_members,
      callsPerStaff: k.callsPerStaff,
      jhpp: m.calls_jhpp,
      wr: m.calls_wr,
      referrals: k.totalReferrals,
    };
  });

  // Month-over-month deltas for the latest available month
  let latestDelta = null;
  if (monthlySeries.length >= 2) {
    const last = monthlySeries[monthlySeries.length - 1];
    const prev = monthlySeries[monthlySeries.length - 2];
    const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 1000) / 10 : 0);
    latestDelta = {
      month: last.month,
      totalCallsPct: pct(last.totalCalls, prev.totalCalls),
      acaRateDelta: Math.round((last.acaRate - prev.acaRate) * 10) / 10,
      referralsPct: pct(last.referrals, prev.referrals),
    };
  }

  res.json({
    year,
    monthsWithData: sorted.length,
    totals: {
      ...totals,
      totalCalls,
      round1Rate: totalCalls ? Math.round((totals.calls_round1 / totalCalls) * 1000) / 10 : 0,
      round2Rate: totalCalls ? Math.round((totals.calls_round2 / totalCalls) * 1000) / 10 : 0,
      round3Rate: totalCalls ? Math.round((totals.calls_round3 / totalCalls) * 1000) / 10 : 0,
      totalAca,
      acaRate: totalAca ? Math.round((totals.aca_yes / totalAca) * 1000) / 10 : 0,
      callsPerStaff: totals.staff_members ? Math.round((totalCalls / totals.staff_members) * 10) / 10 : 0,
      totalReferrals,
      jhppShare: totalReferrals ? Math.round((totals.calls_jhpp / totalReferrals) * 1000) / 10 : 0,
      wrShare: totalReferrals ? Math.round((totals.calls_wr / totalReferrals) * 1000) / 10 : 0,
    },
    monthlySeries,
    latestDelta,
  });
});

// ---------------------------------------------------------------------
// Reports & Publishing (draft -> preview -> publish to all / specific users / view users -> hide)
// ---------------------------------------------------------------------
const reportSchema = z.object({
  title: z.string().min(3).max(180),
  description: z.string().max(2000).optional(),
  reporting_year: z.number().int().min(2000).max(2200).nullable().optional(),
  reporting_month: z.number().int().min(1).max(12).nullable().optional(),
  layout_config: z.record(z.string(), z.unknown()).optional(),
});

function reportActor(req: AuthenticatedRequest) {
  return { id: req.session!.sub, role: req.session!.role, tenantId: req.session!.tenantId };
}
function accessibleReport(req: AuthenticatedRequest) {
  const r = findReport(param(req.params.id));
  return r && canAccessReport(r, reportActor(req)) ? r : null;
}
app.get("/api/v1/reports", requireSession, (req: AuthenticatedRequest, res) => {
  const actor = reportActor(req);
  const rows = listReports(actor, {
    year: req.query.year ? Number(req.query.year) : undefined,
    status: req.query.status as string | undefined,
    search: req.query.search as string | undefined,
  });
  res.json({ reports: rows });
});

app.get("/api/v1/reports/:id", requireSession, async (req: AuthenticatedRequest, res) => {
  const r = accessibleReport(req);
  if (!r) return res.status(404).json({ error: "REPORT_NOT_FOUND" });
  const assignments = req.session!.role !== "view_only" ? getReportAssignments(r.id) : [];
  await audit(req, "report.viewed", 200, "report", r.id);
  res.json({ ...executiveReport(r).report, assignments });
});

app.get("/api/v1/reports/:id/publish-candidates", requireSession, async (req: AuthenticatedRequest, res) => {
  const r = accessibleReport(req);
  if (!r) {
    await audit(req, "report.publish_candidates.denied", 404, "report", param(req.params.id));
    return res.status(404).json({ error: "REPORT_NOT_FOUND" });
  }
  if (!["super_admin", "admin", "manager"].includes(req.session!.role)) {
    await audit(req, "report.publish_candidates.denied", 403, "report", r.id);
    return res.status(403).json({ error: "ACCESS_DENIED" });
  }
  // Exact report tenant, no global user-list fallback, no sensitive account fields.
  const users = db.prepare(`SELECT id, display_name, email, role FROM users
    WHERE tenant_id = ? AND role = 'view_only' AND status = 'active' AND auth_provider = 'local'
    ORDER BY display_name, id`).all(r.tenant_id);
  await audit(req, "report.publish_candidates.viewed", 200, "report", r.id, { count: users.length });
  res.json({ users });
});

app.post("/api/v1/admin/reports", requireSession, requireRole("super_admin", "admin", "manager"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_REPORT", issues: parsed.error.issues });
  if (!req.session!.tenantId) return res.status(403).json({ error: "TENANT_REQUIRED" });
  const r = createReport({
    tenantId: req.session!.tenantId,
    title: parsed.data.title,
    description: parsed.data.description,
    reporting_year: parsed.data.reporting_year,
    reporting_month: parsed.data.reporting_month,
    layout_config: parsed.data.layout_config ? JSON.stringify(parsed.data.layout_config) : null,
    created_by: req.session!.sub,
  });
  await audit(req, "report.created", 201, "report", r.id, { title: r.title });
  res.status(201).json(r);
});

app.patch("/api/v1/admin/reports/:id", requireSession, requireRole("super_admin", "admin", "manager"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  const r = accessibleReport(req);
  if (!r) return res.status(404).json({ error: "REPORT_NOT_FOUND" });
  const parsed = reportSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_REPORT" });
  const updated = updateReport(r.id, {
    title: parsed.data.title,
    description: parsed.data.description,
    reporting_year: parsed.data.reporting_year,
    reporting_month: parsed.data.reporting_month,
    layout_config: parsed.data.layout_config ? JSON.stringify(parsed.data.layout_config) : undefined,
  });
  await audit(req, "report.updated", 200, "report", r.id, { version: updated.version });
  res.json(updated);
});

const publishSchema = z.object({
  target: z.enum(["all", "specific_users", "view_users"]),
  userIds: z.array(z.string().min(1).max(200)).max(500).optional(),
});
app.post("/api/v1/admin/reports/:id/publish", requireSession, requireRole("super_admin", "admin", "manager"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  const r = accessibleReport(req);
  if (!r) return res.status(404).json({ error: "REPORT_NOT_FOUND" });
  const parsed = publishSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_PUBLISH_PAYLOAD" });
  if (parsed.data.target === "specific_users") {
    const ids = parsed.data.userIds ?? [];
    if (!ids.length || ids.some(id => { const u = findUserById(id); return !u || u.tenant_id !== r.tenant_id || u.status !== "active" || u.auth_provider !== "local"; })) {
      return res.status(400).json({ error: "INVALID_REPORT_ASSIGNMENTS" });
    }
  }
  const published = publishReport(r.id, parsed.data.target, parsed.data.userIds);
  await audit(req, "report.published", 200, "report", r.id, { target: parsed.data.target, assignments: parsed.data.userIds?.length });
  res.json(published);
});

app.post("/api/v1/admin/reports/:id/hide", requireSession, requireRole("super_admin", "admin", "manager"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  const r = accessibleReport(req);
  if (!r) return res.status(404).json({ error: "REPORT_NOT_FOUND" });
  const hidden = hideReport(r.id);
  await audit(req, "report.hidden", 200, "report", r.id);
  res.json(hidden);
});

app.delete("/api/v1/admin/reports/:id", requireSession, requireRole("super_admin", "admin"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  const r = accessibleReport(req);
  if (!r) return res.status(404).json({ error: "REPORT_NOT_FOUND" });
  deleteReport(r.id);
  await audit(req, "report.deleted", 200, "report", r.id, { title: r.title });
  res.json({ ok: true });
});

app.get("/api/v1/reports/:id/export", requireSession, async (req: AuthenticatedRequest, res) => {
  const r = accessibleReport(req);
  if (!r) return res.status(404).json({ error: "REPORT_NOT_FOUND" });
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="report.json"`);
  await audit(req, "report.exported", 200, "report", r.id);
  res.json({ report: r, assignments: req.session!.role === "view_only" ? [] : getReportAssignments(r.id), exportedAt: new Date().toISOString() });
});

app.get("/api/v1/reports/:id/executive", requireSession, async (req: AuthenticatedRequest, res) => {
  const r = accessibleReport(req);
  if (!r) { await audit(req, "report.executive.denied", 404, "report", param(req.params.id)); return res.status(404).json({ error: "REPORT_NOT_FOUND" }); }
  const data = executiveReport(r);
  await audit(req, "report.executive.viewed", 200, "report", r.id, { months: data.monthly.length });
  res.json(data);
});

app.get("/api/v1/reports/:id/pdf", requireSession, async (req: AuthenticatedRequest, res) => {
  const r = accessibleReport(req);
  if (!r) { await audit(req, "report.pdf.denied", 404, "report", param(req.params.id)); return res.status(404).json({ error: "REPORT_NOT_FOUND" }); }
  try {
    const pdf = await renderExecutivePdf(executiveReport(r));
    const latest = accessibleReport(req);
    if (!latest || latest.updated_at !== r.updated_at || latest.version !== r.version) {
      await audit(req, "report.pdf.denied", 404, "report", r.id, { reason: "access_changed" });
      return res.status(404).json({ error: "REPORT_NOT_FOUND" });
    }
    await audit(req, "report.pdf.downloaded", 200, "report", r.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="welfare-pride-executive-report.pdf"');
    res.send(pdf);
  } catch {
    await audit(req, "report.pdf.failed", 500, "report", r.id);
    res.status(500).json({ error: "REPORT_PDF_FAILED" });
  }
});

app.get("/api/v1/reports/:id/recipients", requireSession, async (req: AuthenticatedRequest, res) => {
  const r = accessibleReport(req);
  if (!r) { await audit(req, "report.recipients.denied", 404, "report", param(req.params.id)); return res.status(404).json({ error: "REPORT_NOT_FOUND" }); }
  if (req.session!.role === "view_only") { await audit(req, "report.recipients.denied", 403, "report", r.id); return res.status(403).json({ error: "ACCESS_DENIED" }); }
  const users = eligibleRecipients(r, req.session!.role);
  await audit(req, "report.recipients.viewed", 200, "report", r.id, { count: users.length });
  res.json({ users });
});

app.post("/api/v1/reports/:id/email", requireSession, limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  const r = accessibleReport(req);
  if (!r) { await audit(req, "report.email.denied", 404, "report", param(req.params.id)); return res.status(404).json({ error: "REPORT_NOT_FOUND" }); }
  if (req.session!.role === "view_only") { await audit(req, "report.email.denied", 403, "report", r.id); return res.status(403).json({ error: "ACCESS_DENIED" }); }
  const parsed = z.object({ recipientUserId: z.string().min(1).max(200) }).strict().safeParse(req.body);
  if (!parsed.success) { await audit(req, "report.email.denied", 400, "report", r.id); return res.status(400).json({ error: "INVALID_RECIPIENT" }); }
  const recipient = findUserById(parsed.data.recipientUserId);
  if (!canReceiveReport(r, recipient) || (req.session!.role !== "super_admin" && recipient.role === "super_admin")) { await audit(req, "report.email.denied", 404, "report", r.id); return res.status(404).json({ error: "RECIPIENT_NOT_FOUND" }); }
  // Refuse rather than bypass mandatory BCC; sendEmail rechecks atomically at dispatch.
  if ([getEmailConfig().global_bcc, process.env.GLOBAL_EMAIL_BCC].some(v => v?.trim())) {
    await audit(req, "report.email.denied", 409, "report", r.id, { reason: "global_bcc" });
    return res.status(409).json({ error: "REPORT_EMAIL_GLOBAL_BCC_CONFIGURED" });
  }
  let dispatchStarted = false;
  try {
    const pdf = await renderExecutivePdf(executiveReport(r));
    const latest = findReport(r.id), currentRecipient = findUserById(recipient.id), actor = findUserById(req.session!.sub);
    if (!latest || latest.status !== "published" || latest.updated_at !== r.updated_at || latest.version !== r.version || latest.publish_target !== r.publish_target ||
        !actor || actor.status !== "active" || actor.tenant_id !== req.session!.tenantId || actor.role !== req.session!.role || actor.session_version !== req.session!.sessionVersion ||
        !canAccessReport(latest, reportActor(req)) || !canReceiveReport(latest, currentRecipient) || (req.session!.role !== "super_admin" && currentRecipient.role === "super_admin") || currentRecipient.email !== recipient.email) {
      await audit(req, "report.email.denied", 409, "report", r.id, { reason: "access_changed" });
      return res.status(409).json({ error: "REPORT_ACCESS_CHANGED" });
    }
    dispatchStarted = true;
    const result = await sendEmail({ to: currentRecipient.email, subject: "Welfare Pride executive report", text: "The requested Welfare Pride executive report is attached. Please handle it securely.", correlationId: req.requestId, attachments: [{ filename: "welfare-pride-executive-report.pdf", content: pdf, contentType: "application/pdf" }], requireNoBcc: true });
    if (!result.ok) {
      const unknown = result.status === "unknown";
      const disabled = result.error === "Email engine is disabled";
      await audit(req, unknown ? "report.email.unknown" : "report.email.failed", disabled ? 409 : 502, "report", r.id, { recipientUserId: recipient.id, provider: result.provider, logId: result.logId });
      return res.status(disabled ? 409 : 502).json({ ok: false, status: unknown ? "unknown" : "failed", error: unknown ? "REPORT_EMAIL_UNKNOWN" : disabled ? "REPORT_EMAIL_DISABLED" : "REPORT_EMAIL_FAILED" });
    }
    const simulated = result.status === "simulated" || result.provider === "simulation";
    await audit(req, simulated ? "report.email.simulated" : "report.email.accepted", 200, "report", r.id, { recipientUserId: recipient.id, provider: result.provider, logId: result.logId });
    return res.json({ ok: true, status: simulated ? "simulated" : "accepted", provider: result.provider });
  } catch {
    const unknown = dispatchStarted;
    await audit(req, unknown ? "report.email.unknown" : "report.email.failed", 500, "report", r.id, { recipientUserId: recipient.id });
    return res.status(500).json({ ok: false, status: unknown ? "unknown" : "failed", error: unknown ? "REPORT_EMAIL_UNKNOWN" : "REPORT_EMAIL_FAILED" });
  }
});

// ---------------------------------------------------------------------
// Audit Center (Module 2 — advanced filtering + CSV export)
// ---------------------------------------------------------------------
app.get("/api/v1/admin/audit", requireSession, requireRole("super_admin", "admin"), async (req: AuthenticatedRequest, res) => {
  if (req.session!.role !== "super_admin" && !req.session!.tenantId) return res.status(403).json({ error: "TENANT_REQUIRED" });
  const result = listAuditEvents({
    // Super admins are platform-wide, even when assigned a tenant or when tenantId is null.
    tenantId: req.session!.role === "super_admin" ? undefined : req.session!.tenantId,
    actor: req.query.actor as string,
    action: req.query.action as string,
    severity: req.query.severity as string,
    resourceType: req.query.resourceType as string,
    correlationId: req.query.correlationId as string,
    from: req.query.from as string,
    to: req.query.to as string,
    search: req.query.search as string,
    limit: req.query.limit ? Number(req.query.limit) : 50,
    offset: req.query.offset ? Number(req.query.offset) : 0,
  });
  await audit(req, "audit.center.viewed", 200, "audit", null, { filters: req.query });
  res.json(result);
});

app.get("/api/v1/admin/audit/export", requireSession, requireRole("super_admin", "admin"), async (req: AuthenticatedRequest, res) => {
  if (req.session!.role !== "super_admin" && !req.session!.tenantId) return res.status(403).json({ error: "TENANT_REQUIRED" });
  const { events } = listAuditEvents({
    tenantId: req.session!.role === "super_admin" ? undefined : req.session!.tenantId,
    limit: req.query.limit ? Number(req.query.limit) : 5000,
  });
  const csv = Papa.unparse({
    fields: ["Occurred At (UTC)", "Request ID", "Actor Email", "Actor Role", "Action", "Severity", "Resource Type", "Resource ID", "Real IP", "Geo Country", "Method", "Status", "Metadata"],
    data: events.map(e => [e.occurred_at, e.request_id, e.actor_email ?? "", e.actor_role ?? "", e.action, e.severity, e.resource_type, e.resource_id ?? "", e.real_ip ?? "", e.geo_country ?? "", e.method, e.status_code, e.metadata ?? ""]),
  }, { newline: "\n", escapeFormulae: true });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="wp-hpp-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
  await audit(req, "audit.csv.exported", 200, "audit");
  res.send(csv);
});

// ---------------------------------------------------------------------
// SIEM / Syslog forwarding (Module 2)
// ---------------------------------------------------------------------
app.get("/api/v1/admin/siem", requireSession, requireRole("super_admin"), (_req, res) => {
  const c = getSiemConfig();
  res.json({ ...c, webhook_token: c.webhook_token ? "__configured__" : null });
});
app.put("/api/v1/admin/siem", requireSession, requireRole("super_admin"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  const body = { ...req.body };
  if (body.webhook_token === "__configured__") delete body.webhook_token;
  const cfg = updateSiemConfig(body);
  await audit(req, "siem.config.updated", 200, "siem");
  res.json({ ...cfg, webhook_token: cfg.webhook_token ? "__configured__" : null });
});
app.post("/api/v1/admin/siem/test", requireSession, requireRole("super_admin"), async (req: AuthenticatedRequest, res) => {
  const dest = req.body?.dest === "webhook" ? "webhook" : "syslog";
  const result = await testSiem(dest);
  await audit(req, "siem.test", result.ok ? 200 : 500, "siem", null, { dest, result });
  res.json(result);
});
app.post("/api/v1/admin/siem/flush", requireSession, requireRole("super_admin"), async (req: AuthenticatedRequest, res) => {
  const result = await flushSiemBuffer();
  await audit(req, "siem.buffer.flushed", 200, "siem", null, result);
  res.json(result);
});

// ---------------------------------------------------------------------
// Resilient Email Engine (Module 4)
// ---------------------------------------------------------------------
app.get("/api/v1/admin/email", requireSession, requireRole("super_admin"), (_req, res) => {
  const c = getEmailConfig();
  res.json({
    ...c,
    smtp_pass: c.smtp_pass ? "__configured__" : null,
    graph_client_secret: c.graph_client_secret ? "__configured__" : null,
    circuit: emailCircuitStatus(),
  });
});
const emailConfigSchema = z.object({
  primary_provider: z.enum(["smtp", "graph", "simulation"]).optional(),
  secondary_provider: z.enum(["smtp", "graph", "simulation"]).nullable().optional(),
  smtp_host: z.string().max(253).nullable().optional(),
  smtp_port: z.number().int().min(1).max(65535).nullable().optional(),
  smtp_secure: z.union([z.literal(0), z.literal(1)]).optional(),
  smtp_user: z.string().max(320).nullable().optional(),
  smtp_pass: z.string().max(4096).nullable().optional(),
  smtp_from: z.string().max(320).nullable().optional(),
  graph_client_id: z.string().max(128).nullable().optional(),
  graph_client_secret: z.string().max(4096).nullable().optional(),
  graph_tenant_id: z.string().max(128).regex(/^[A-Za-z0-9.-]+$/).nullable().optional(),
  graph_sender: z.string().max(320).nullable().optional(),
  global_bcc: z.string().max(2000).nullable().optional(),
  enabled: z.union([z.literal(0), z.literal(1)]).optional(),
}).strict();
app.put("/api/v1/admin/email", requireSession, requireRole("super_admin"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return res.status(400).json({ error: "INVALID_EMAIL_CONFIG" });
  const body = { ...req.body };
  if (body.smtp_pass === "__configured__") delete body.smtp_pass;
  if (body.graph_client_secret === "__configured__") delete body.graph_client_secret;
  const parsed = emailConfigSchema.safeParse(body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_EMAIL_CONFIG" });
  const cfg = updateEmailConfig(parsed.data);
  await audit(req, "email.config.updated", 200, "email");
  res.json({ ...cfg, smtp_pass: cfg.smtp_pass ? "__configured__" : null, graph_client_secret: cfg.graph_client_secret ? "__configured__" : null });
});
// Mail logs have no tenant provenance, so neither listing nor resend is tenant-safe.
app.get("/api/v1/admin/mail-logs", requireSession, requireRole("super_admin"), (_req, res) => {
  res.json({ logs: listMailLogs(200) });
});
app.post("/api/v1/admin/mail-logs/:id/resend", requireSession, requireRole("super_admin"), async (req: AuthenticatedRequest, res) => {
  const result = await resendMailLog(param(req.params.id));
  await audit(req, "email.resend", result.ok ? 200 : 500, "mail_log", param(req.params.id), result);
  res.json(result);
});
app.post("/api/v1/admin/email/test", requireSession, requireRole("super_admin"), async (req: AuthenticatedRequest, res) => {
  const to = String(req.body?.to || req.session!.email || "");
  if (!to) return res.status(400).json({ error: "RECIPIENT_REQUIRED" });
  const result = await sendEmail({
    to,
    subject: "Test — Welfare Pride Reporting Portal email engine",
    text: "This is a test message from the Welfare Pride HPP Reporting Portal email engine with automatic provider failover.",
    correlationId: req.requestId,
  });
  await audit(req, "email.test", result.ok ? 200 : 500, "email", null, { to, provider: result.provider });
  res.json(result);
});

// ---------------------------------------------------------------------
// Backup, restore & data portability (Module 5)
// ---------------------------------------------------------------------
app.get("/api/v1/admin/backups", requireSession, requireRole("super_admin", "admin"), (_req, res) => {
  res.json({ backups: listBackups() });
});
app.post("/api/v1/admin/backups", requireSession, requireRole("super_admin"), (_req, res) => {
  res.status(501).json({ error: "BACKUP_CREATION_UNAVAILABLE" });
});
app.get("/api/v1/admin/backups/:filename", requireSession, requireRole("super_admin"), async (req: AuthenticatedRequest, res) => {
  const p = backupFilePath(param(req.params.filename));
  if (!p) return res.status(404).json({ error: "BACKUP_NOT_FOUND" });
  await audit(req, "backup.downloaded", 200, "backup", param(req.params.filename));
  res.download(p, param(req.params.filename));
});
app.delete("/api/v1/admin/backups/:id", requireSession, requireRole("super_admin"), async (req: AuthenticatedRequest, res) => {
  deleteBackupRecord(param(req.params.id));
  await audit(req, "backup.deleted", 200, "backup", param(req.params.id));
  res.json({ ok: true });
});
app.post("/api/v1/admin/backups/restore", requireSession, requireRole("super_admin"), (_req, res) => {
  res.status(501).json({ error: "ONLINE_RESTORE_UNAVAILABLE", message: "Use a verified offline restoration procedure." });
});
app.get("/api/v1/admin/config/export", requireSession, requireRole("super_admin"), async (req: AuthenticatedRequest, res) => {
  const cfg = exportJsonConfig();
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="wp-hpp-config.json"`);
  await audit(req, "config.exported", 200, "config");
  res.json(cfg);
});
app.post("/api/v1/admin/config/import", requireSession, requireRole("super_admin"), async (req: AuthenticatedRequest, res) => {
  try {
    const result = importJsonConfig(req.body);
    await audit(req, "config.imported", 200, "config", null, result);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------
// White-label branding (Module 6)
// ---------------------------------------------------------------------
app.put("/api/v1/admin/branding", requireSession, requireRole("super_admin"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  const allowed = z.object({
    company_name: z.string().max(120).optional(),
    tagline: z.string().max(200).optional(),
    logo_url: z.string().max(500).optional(),
    logo_dark_url: z.string().max(500).optional().nullable(),
    icon_url: z.string().max(500).optional(),
    favicon_url: z.string().max(500).optional(),
    primary_color: z.string().regex(/^#[0-9A-Fa-f]{3,8}$/).optional(),
    secondary_color: z.string().regex(/^#[0-9A-Fa-f]{3,8}$/).optional(),
    email_header_text: z.string().max(200).optional(),
    default_theme: z.enum(["light", "dark", "system"]).optional(),
    allow_theme_override: z.number().optional(),
  });
  const parsed = allowed.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BRANDING" });
  const cfg = updateBrandConfig(parsed.data, req.session!.sub);
  await audit(req, "branding.updated", 200, "branding", null, parsed.data);
  res.json(cfg);
});

// ---------------------------------------------------------------------
// Entra ID SAML 2.0 / OIDC config + conversion engine (Module 1)
// ---------------------------------------------------------------------
app.get("/api/v1/admin/entra", requireSession, requireRole("super_admin"), (_req, res) => {
  const c = getEntraConfig();
  res.json({ ...c, client_secret: c.client_secret ? "__configured__" : null });
});
app.put("/api/v1/admin/entra", requireSession, requireRole("super_admin"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  const body = { ...req.body };
  if (body.client_secret === "__configured__") delete body.client_secret;
  const cfg = updateEntraConfig(body);
  await audit(req, "entra.config.updated", 200, "entra");
  res.json({ ...cfg, client_secret: cfg.client_secret ? "__configured__" : null });
});

// ---------------------------------------------------------------------
// Edge firewall IP rules (Module 2)
// ---------------------------------------------------------------------
app.get("/api/v1/admin/ip-rules", requireSession, requireRole("super_admin"), (_req, res) => {
  res.json({ rules: listIpRules() });
});
app.post("/api/v1/admin/ip-rules", requireSession, requireRole("super_admin"), async (req: AuthenticatedRequest, res) => {
  const type = z.enum(["allow", "deny", "geo_block"]).safeParse(req.body?.type);
  const value = z.string().min(1).safeParse(req.body?.value);
  if (!type.success || !value.success) return res.status(400).json({ error: "INVALID_RULE" });
  const rule = addIpRule(type.data, value.data, req.body?.reason ? String(req.body.reason) : null, req.session!.sub);
  await audit(req, "ip_rule.created", 201, "ip_rule", rule.id, { type: rule.type, value: rule.value });
  res.status(201).json(rule);
});
app.delete("/api/v1/admin/ip-rules/:id", requireSession, requireRole("super_admin"), async (req: AuthenticatedRequest, res) => {
  deleteIpRule(param(req.params.id));
  await audit(req, "ip_rule.deleted", 200, "ip_rule", param(req.params.id));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, version: "2.0.0", env: process.env.NODE_ENV || "development" });
});

// Static serving (production)
// ---------------------------------------------------------------------
async function start() {
  runMigrations();
  const quarantined = await quarantineLegacyCredentials();
  if (quarantined) writeLog("warn", "security.legacy_credentials_quarantined", { count: quarantined });
  if (process.env.NODE_ENV === "production") {
    const configured = process.env.APP_ORIGIN;
    try {
      const parsed = new URL(configured || "");
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== configured) throw new Error();
    } catch { throw new Error("APP_ORIGIN must be an exact HTTP(S) origin in production."); }
  }
  const root = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.resolve(root, "public");
  const brandingDir = path.resolve(root, "..", "branding");

  app.use("/assets/branding", express.static(brandingDir, { fallthrough: false, immutable: true, maxAge: "30d", etag: true }));
  app.use(express.static(publicDir, { index: false, fallthrough: true, maxAge: "1h", etag: true }));
  app.use((_req, res) => res.sendFile(path.join(publicDir, "index.html")));

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, process.env.BIND_ADDRESS || "0.0.0.0", () => {
    writeLog("info", "server.started", { environment: process.env.NODE_ENV || "development", port });
    console.log(`Server running on http://localhost:${port}`);
  });
}

export { app };
if (process.env.NODE_ENV !== "test") start();
