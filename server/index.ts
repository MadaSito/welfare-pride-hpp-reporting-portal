import express from "express";
import helmet from "helmet";
import multer from "multer";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { TOTP, Secret } from "otpauth";
import { decodeJwt, SignJWT } from "jose";
import { z } from "zod";

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
import {
  exportMetricsCsv,
  importMetricsCsv,
  exportAuditCsv,
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
app.use(["/api/v1/auth", "/api/v1/admin/invitations"], (_req, res, next) => {
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

app.get("/api/v1/metrics", requireSession, async (req: AuthenticatedRequest, res) => {
  const year = req.query.year ? Number(req.query.year) : undefined;
  const rows = listMonthlyMetrics(year, req.session!.tenantId);
  const data = rows.map(m => ({ ...m, kpis: computeKpis(m) }));
  await audit(req, "metrics.list.viewed", 200, "metrics", null, { count: rows.length, year });
  res.json({ metrics: data, availableYears: listAvailableYears() });
});

app.get("/api/v1/metrics/years", requireSession, (_req, res) => {
  res.json({ years: listAvailableYears() });
});

app.get("/api/v1/metrics/:year/:month", requireSession, (req: AuthenticatedRequest, res) => {
  const m = findMonthlyMetric(Number(req.params.year), Number(req.params.month), req.session!.tenantId);
  if (!m) return res.status(404).json({ error: "NO_METRIC_DATA" });
  res.json({ ...m, kpis: computeKpis(m) });
});

app.put("/api/v1/metrics/:year/:month", requireSession, requireRole("super_admin", "admin", "manager"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
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
  const result = importMetricsCsv(csvText, req.session!.sub);
  await audit(req, "metrics.csv.imported", 200, "metrics", null, { imported: result.imported, errors: result.errors.length });
  res.json(result);
});

app.get("/api/v1/metrics/export", requireSession, async (req: AuthenticatedRequest, res) => {
  const year = req.query.year ? Number(req.query.year) : undefined;
  const csv = exportMetricsCsv(year);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="wp-hpp-metrics-${year || "all"}.csv"`);
  await audit(req, "metrics.csv.exported", 200, "metrics", null, { year });
  res.send(csv);
});

// ---------------------------------------------------------------------
// Dashboard aggregations & trends
// ---------------------------------------------------------------------
app.get("/api/v1/dashboard/summary", requireSession, (req: AuthenticatedRequest, res) => {
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
  reporting_year: z.number().int().optional(),
  reporting_month: z.number().int().min(1).max(12).optional(),
  layout_config: z.record(z.string(), z.unknown()).optional(),
});

app.get("/api/v1/reports", requireSession, (req: AuthenticatedRequest, res) => {
  const actor = { id: req.session!.sub, role: req.session!.role, tenantId: req.session!.tenantId };
  const rows = listReports(actor, {
    year: req.query.year ? Number(req.query.year) : undefined,
    status: req.query.status as string | undefined,
    search: req.query.search as string | undefined,
  });
  res.json({ reports: rows });
});

app.get("/api/v1/reports/:id", requireSession, (req: AuthenticatedRequest, res) => {
  const r = findReport(param(req.params.id));
  if (!r) return res.status(404).json({ error: "REPORT_NOT_FOUND" });
  if (req.session!.role === "view_only" && r.status !== "published") {
    return res.status(404).json({ error: "REPORT_NOT_FOUND" });
  }
  const assignments = req.session!.role !== "view_only" ? getReportAssignments(r.id) : [];
  res.json({ ...r, layout_config: r.layout_config ? JSON.parse(r.layout_config) : {}, assignments });
});

app.post("/api/v1/admin/reports", requireSession, requireRole("super_admin", "admin", "manager"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_REPORT", issues: parsed.error.issues });
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
  const r = findReport(param(req.params.id));
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
  userIds: z.array(z.string()).optional(),
});
app.post("/api/v1/admin/reports/:id/publish", requireSession, requireRole("super_admin", "admin", "manager"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  const r = findReport(param(req.params.id));
  if (!r) return res.status(404).json({ error: "REPORT_NOT_FOUND" });
  const parsed = publishSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_PUBLISH_PAYLOAD" });
  const published = publishReport(r.id, parsed.data.target, parsed.data.userIds);
  await audit(req, "report.published", 200, "report", r.id, { target: parsed.data.target, assignments: parsed.data.userIds?.length });
  res.json(published);
});

app.post("/api/v1/admin/reports/:id/hide", requireSession, requireRole("super_admin", "admin", "manager"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  const r = findReport(param(req.params.id));
  if (!r) return res.status(404).json({ error: "REPORT_NOT_FOUND" });
  const hidden = hideReport(r.id);
  await audit(req, "report.hidden", 200, "report", r.id);
  res.json(hidden);
});

app.delete("/api/v1/admin/reports/:id", requireSession, requireRole("super_admin", "admin"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  const r = findReport(param(req.params.id));
  if (!r) return res.status(404).json({ error: "REPORT_NOT_FOUND" });
  deleteReport(r.id);
  await audit(req, "report.deleted", 200, "report", r.id, { title: r.title });
  res.json({ ok: true });
});

app.get("/api/v1/reports/:id/export", requireSession, async (req: AuthenticatedRequest, res) => {
  const r = findReport(param(req.params.id));
  if (!r) return res.status(404).json({ error: "REPORT_NOT_FOUND" });
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="report-${r.id}.json"`);
  await audit(req, "report.exported", 200, "report", r.id);
  res.json({ report: r, assignments: getReportAssignments(r.id), exportedAt: new Date().toISOString() });
});

// ---------------------------------------------------------------------
// Audit Center (Module 2 — advanced filtering + CSV export)
// ---------------------------------------------------------------------
app.get("/api/v1/admin/audit", requireSession, requireRole("super_admin", "admin"), async (req: AuthenticatedRequest, res) => {
  const result = listAuditEvents({
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
  const csv = exportAuditCsv(req.query.limit ? Number(req.query.limit) : 5000);
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
app.put("/api/v1/admin/email", requireSession, requireRole("super_admin"), limiters.writeOps, async (req: AuthenticatedRequest, res) => {
  const body = { ...req.body };
  if (body.smtp_pass === "__configured__") delete body.smtp_pass;
  if (body.graph_client_secret === "__configured__") delete body.graph_client_secret;
  const cfg = updateEmailConfig(body);
  await audit(req, "email.config.updated", 200, "email");
  res.json({ ...cfg, smtp_pass: cfg.smtp_pass ? "__configured__" : null, graph_client_secret: cfg.graph_client_secret ? "__configured__" : null });
});
app.get("/api/v1/admin/mail-logs", requireSession, requireRole("super_admin", "admin"), (_req, res) => {
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

start();
