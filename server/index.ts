import "dotenv/config";
import { Algorithm, hash as hashPassword, verify as verifyPassword } from "@node-rs/argon2";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Secret, TOTP } from "otpauth";
import { z } from "zod";
import { recordAudit } from "./audit";
import { parseHppDataset, validateHppDataset } from "./ingestion";
import { writeLog, requestLogging, type LoggedRequest } from "./logging";
import { createUser, disableUser, findUserByEmail, findUserById, getPool, listUsers, markSignInFailure, markSignInSuccess, setMfaSecret, updatePassword } from "./repository";
import { attachSession, clearSession, createSession, decryptSecret, encryptSecret, mayAssignRole, requireRole, requireSession, sessionMiddleware, type AuthenticatedRequest, validatePassword, verifyCsrf } from "./security";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === "production" ? {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      fontSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
    },
  } : false,
  referrerPolicy: { policy: "no-referrer" },
}));
app.use(express.json({ limit: "200kb", type: "application/json" }));
app.use(requestLogging);
app.use(sessionMiddleware);
app.use(verifyCsrf);

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "RATE_LIMITED" } });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 4 }, fileFilter: (_req, file, callback) => callback(null, /\.(csv|xlsx)$/i.test(file.originalname)) });
const loginSchema = z.object({ email: z.string().email().max(320).transform(value => value.toLowerCase().trim()), password: z.string().min(1).max(256) });
const codeSchema = z.object({ challenge: z.string().min(32).max(4096), code: z.string().regex(/^\d{6}$/) });
const userSchema = z.object({ email: z.string().email().max(320).transform(value => value.toLowerCase().trim()), displayName: z.string().min(2).max(160), role: z.enum(["platform_admin", "tenant_admin", "analyst", "customer"]), tenantId: z.string().uuid().nullable() });
const reportSchema = z.object({ title: z.string().min(3).max(180), description: z.string().max(2000).optional(), layoutConfig: z.record(z.string(), z.unknown()).default({}) });
const publicationSchema = z.object({ tenantIds: z.array(z.string().uuid()).min(1).max(100), authorizedPeriods: z.array(z.object({ year: z.number().int().min(2000).max(2200), month: z.number().int().min(1).max(12) })).max(60).default([]) });
const siemSchema = z.object({ protocol: z.enum(["syslog_tls", "https"]), hostname: z.string().min(1).max(253).regex(/^[a-zA-Z0-9.-]+$/), port: z.number().int().min(1).max(65535), facility: z.string().max(32).optional() });
const passwordChangeSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(14).max(256) });

async function audit(req: AuthenticatedRequest, action: string, statusCode: number, resourceType: string, resourceId?: string | null, metadata?: object) {
  await recordAudit({ requestId: req.requestId ?? "unknown", actorId: req.session?.sub ?? null, tenantId: req.session?.tenantId ?? null, action, severity: statusCode >= 500 ? "critical" : statusCode >= 400 ? "warning" : "info", resourceType, resourceId, ipHash: req.ipHash ?? "unknown", userAgent: req.header("user-agent") ?? undefined, method: req.method, statusCode, metadata, actorRole: req.session?.role });
}

function scalarRouteParam(value: string | string[] | undefined) { return typeof value === "string" && value.length <= 128 ? value : null; }

app.get("/api/v1/health", async (_req, res) => res.status(200).json({ status: "ok", database: Boolean(getPool()), timestamp: new Date().toISOString() }));
app.get("/api/v1/auth/session", requireSession, async (req: AuthenticatedRequest, res) => {
  const user = await findUserById(req.session!.sub); if (!user) return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
  res.json({ user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role, tenantId: user.tenant_id }, csrfToken: req.session!.csrf });
});

app.post("/api/v1/auth/login", loginLimiter, async (req: AuthenticatedRequest, res) => {
  const parsed = loginSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_CREDENTIALS" });
  const user = await findUserByEmail(parsed.data.email); const passwordValid = user?.password_hash ? await verifyPassword(user.password_hash, parsed.data.password).catch(() => false) : false;
  if (!user || !passwordValid || user.status !== "active" || (user.locked_until && user.locked_until > new Date())) { if (user) await markSignInFailure(user.id); await audit(req, "auth.sign_in.failed", 401, "user", user?.id, { emailHash: parsed.data.email.length }); return res.status(401).json({ error: "INVALID_CREDENTIALS" }); }
  if (!user.mfa_secret_encrypted && user.mfa_required) { const challenge = await createSession({ sub: user.id, role: user.role, tenantId: user.tenant_id, stage: "mfa_enroll" }, "10m"); await audit(req, "auth.mfa_enrollment.required", 200, "user", user.id); return res.json({ next: "MFA_ENROLL", challenge }); }
  const challenge = await createSession({ sub: user.id, role: user.role, tenantId: user.tenant_id, stage: "mfa_verify" }, "10m"); await audit(req, "auth.password.verified", 200, "user", user.id); return res.json({ next: "MFA_VERIFY", challenge });
});

app.post("/api/v1/auth/mfa/enroll", async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ challenge: z.string().min(32).max(4096) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_REQUEST" });
  const { readSession } = await import("./security"); const session = await readSession(parsed.data.challenge); if (!session || session.stage !== "mfa_enroll") return res.status(401).json({ error: "MFA_CHALLENGE_INVALID" });
  const user = await findUserById(session.sub); if (!user) return res.status(401).json({ error: "MFA_CHALLENGE_INVALID" });
  const seed = randomBytes(20);
  const seedBuffer = seed.buffer.slice(seed.byteOffset, seed.byteOffset + seed.byteLength) as ArrayBuffer;
  const secret = new TOTP({ issuer: "Welfare Pride HPP", label: user.email, algorithm: "SHA1", digits: 6, period: 30, secret: new Secret({ buffer: seedBuffer }) });
  await setMfaSecret(user.id, encryptSecret(secret.secret.base32));
  await audit(req, "auth.mfa.enrollment.started", 200, "user", user.id);
  res.json({ uri: secret.toString(), challenge: parsed.data.challenge });
});

app.post("/api/v1/auth/mfa/verify", async (req: AuthenticatedRequest, res) => {
  const parsed = codeSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_MFA_CODE" });
  const { readSession } = await import("./security"); const pending = await readSession(parsed.data.challenge); if (!pending || pending.stage === "full") return res.status(401).json({ error: "MFA_CHALLENGE_INVALID" });
  const user = await findUserById(pending.sub); if (!user) return res.status(401).json({ error: "MFA_CHALLENGE_INVALID" });
  let secret = user.mfa_secret_encrypted ? decryptSecret(user.mfa_secret_encrypted) : null;
  if (!secret && pending.stage === "mfa_enroll") return res.status(409).json({ error: "MFA_ENROLLMENT_PENDING", message: "Complete enrollment verification with the enrollment secret in the client flow." });
  const valid = secret ? new TOTP({ issuer: "Welfare Pride HPP", label: user.id, secret }).validate({ token: parsed.data.code, window: 1 }) !== null : false;
  if (!valid) { await audit(req, "auth.mfa.failed", 401, "user", user.id); return res.status(401).json({ error: "INVALID_MFA_CODE" }); }
  await markSignInSuccess(user.id); const token = await createSession({ sub: user.id, role: user.role, tenantId: user.tenant_id, stage: "full" }); attachSession(res, token); await audit(req, "auth.sign_in.succeeded", 200, "user", user.id); res.json({ success: true });
});

app.post("/api/v1/auth/logout", requireSession, async (req: AuthenticatedRequest, res) => { clearSession(res); await audit(req, "auth.sign_out", 204, "session", req.session?.sub); res.status(204).end(); });
app.post("/api/v1/auth/password", requireSession, async (req: AuthenticatedRequest, res) => { const parsed = passwordChangeSchema.safeParse(req.body); if (!parsed.success || !validatePassword(parsed.data.newPassword)) return res.status(400).json({ error: "PASSWORD_POLICY_REJECTED" }); const user = await findUserById(req.session!.sub); const currentMatches = user?.password_hash ? await verifyPassword(user.password_hash, parsed.data.currentPassword).catch(() => false) : false; if (!user || !currentMatches) { await audit(req, "auth.password_change.failed", 401, "user", req.session!.sub); return res.status(401).json({ error: "INVALID_CREDENTIALS" }); } const passwordHash = await hashPassword(parsed.data.newPassword, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }); await updatePassword(user.id, passwordHash); await audit(req, "auth.password_changed", 204, "user", user.id); res.status(204).end(); });

app.get("/api/v1/admin/users", requireSession, requireRole("platform_admin", "tenant_admin"), async (req: AuthenticatedRequest, res) => { const users = await listUsers(req.session?.role === "tenant_admin" ? req.session.tenantId : null); await audit(req, "user.list.viewed", 200, "user"); res.json({ users }); });
app.post("/api/v1/admin/users", requireSession, requireRole("platform_admin", "tenant_admin"), async (req: AuthenticatedRequest, res) => { const parsed = userSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_USER_REQUEST" }); if (!mayAssignRole(req.session!.role, parsed.data.role) || (req.session?.role === "tenant_admin" && parsed.data.tenantId !== req.session.tenantId)) { await audit(req, "user.creation.denied", 403, "user", null, { requestedRole: parsed.data.role, requestedTenantId: parsed.data.tenantId }); return res.status(403).json({ error: "ROLE_OR_TENANT_SCOPE_VIOLATION" }); } const initialPassword = randomBytes(22).toString("base64url"); const passwordHash = await hashPassword(initialPassword, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }); const id = await createUser({ ...parsed.data, passwordHash }); await audit(req, "user.created", 201, "user", id, { role: parsed.data.role, tenantId: parsed.data.tenantId }); res.status(201).json({ id, oneTimePassword: initialPassword, message: "Present this password only through a verified secure channel. MFA enrollment is required at first sign-in." }); });
app.patch("/api/v1/admin/users/:id/disable", requireSession, requireRole("platform_admin", "tenant_admin"), async (req: AuthenticatedRequest, res) => { const targetId = scalarRouteParam(req.params.id); if (!targetId) return res.status(400).json({ error: "INVALID_USER_ID" }); const target = await findUserById(targetId); if (!target || !mayAssignRole(req.session!.role, target.role) || (req.session?.role === "tenant_admin" && target.tenant_id !== req.session.tenantId)) return res.status(404).json({ error: "USER_NOT_FOUND" }); await disableUser(target.id); await audit(req, "user.disabled", 204, "user", target.id, { previousStatus: target.status, newStatus: "disabled" }); res.status(204).end(); });
app.post("/api/v1/admin/uploads/validate", requireSession, requireRole("platform_admin", "tenant_admin", "analyst"), upload.single("dataset"), async (req: AuthenticatedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: "DATASET_REQUIRED" });
  const period = z.object({ sourceMonth: z.coerce.number().int().min(1).max(12), sourceYear: z.coerce.number().int().min(2000).max(2200) }).safeParse(req.body);
  if (!period.success) return res.status(400).json({ error: "SOURCE_PERIOD_REQUIRED" });
  const result = await validateHppDataset(req.file);
  if (!result.valid) { await audit(req, "dataset.rejected", 422, "upload", result.sha256, { sourceFilename: req.file.originalname, rowCount: result.rowCount, missingHeaders: result.missingHeaders }); return res.status(422).json(result); }
  const client = getPool(); if (!client) return res.status(503).json({ error: "DATABASE_UNAVAILABLE" });
  const existing = await client.query<{ id: string }>(`SELECT id FROM uploads WHERE sha256 = $1 LIMIT 1`, [result.sha256]);
  if (existing.rows[0]) return res.status(409).json({ error: "DUPLICATE_DATASET", uploadId: existing.rows[0].id });
  const dataDir = path.resolve(process.env.DATA_DIR || "./data", "uploads"); await mkdir(dataDir, { recursive: true, mode: 0o750 });
  const storageKey = `${result.sha256}.${req.file.originalname.toLowerCase().endsWith(".xlsx") ? "xlsx" : "csv"}`;
  await writeFile(path.join(dataDir, storageKey), req.file.buffer, { mode: 0o640, flag: "wx" });
  const uploadId = randomUUID();
  await client.query(`INSERT INTO uploads (id, storage_key, sha256, source_filename, source_month, source_year, record_count, status, validation_results, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'validated',$8,$9)`, [uploadId, storageKey, result.sha256, req.file.originalname.slice(0, 255), period.data.sourceMonth, period.data.sourceYear, result.rowCount, JSON.stringify(result), req.session!.sub]);
  await audit(req, "dataset.stored", 201, "upload", uploadId, { sourceFilename: req.file.originalname, rowCount: result.rowCount, sha256: result.sha256, sourceMonth: period.data.sourceMonth, sourceYear: period.data.sourceYear });
  res.status(201).json({ ...result, uploadId, storageKey, mapping: [{ source: "Call ID", target: "call_id" }, { source: "Member ID", target: "member_id" }, { source: "Renewal Date", target: "renewal_date" }, { source: "Reachable (Yes/No)", target: "reachable" }, { source: "Call Status", target: "call_status" }] });
});
app.post("/api/v1/admin/uploads/:id/process", requireSession, requireRole("platform_admin", "tenant_admin", "analyst"), async (req: AuthenticatedRequest, res) => { const uploadId = scalarRouteParam(req.params.id); if (!uploadId) return res.status(400).json({ error: "INVALID_UPLOAD_ID" }); const client = getPool(); if (!client) return res.status(503).json({ error: "DATABASE_UNAVAILABLE" }); const uploadResult = await client.query<{ id: string; storage_key: string; status: string }>(`SELECT id, storage_key, status FROM uploads WHERE id = $1 FOR UPDATE`, [uploadId]); const uploadRecord = uploadResult.rows[0]; if (!uploadRecord) return res.status(404).json({ error: "UPLOAD_NOT_FOUND" }); if (uploadRecord.status === "processed") return res.status(409).json({ error: "UPLOAD_ALREADY_PROCESSED" }); const filePath = path.resolve(process.env.DATA_DIR || "./data", "uploads", path.basename(uploadRecord.storage_key)); let source: Buffer; try { source = await (await import("node:fs/promises")).readFile(filePath); } catch { await audit(req, "dataset.processing.failed", 409, "upload", uploadId, { reason: "source_not_available" }); return res.status(409).json({ error: "SOURCE_FILE_NOT_AVAILABLE" }); } let records; try { records = await parseHppDataset({ originalname: uploadRecord.storage_key, buffer: source }); } catch (error) { await audit(req, "dataset.processing.failed", 422, "upload", uploadId, { reason: error instanceof Error ? error.message : "parse_failed" }); return res.status(422).json({ error: "DATASET_PARSE_REJECTED" }); } await client.query("BEGIN"); try { for (const record of records) await client.query(`INSERT INTO outreach_records (upload_id, call_id, member_id, renewal_date, reachable, call_status_code, attempt_one_code, attempt_two_code, attempt_three_code, raw_fields) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [uploadId, record.callId, record.memberId, record.renewalDate, record.reachable, record.callStatusCode, record.attemptOneCode, record.attemptTwoCode, record.attemptThreeCode, JSON.stringify(record.rawFields)]); await client.query(`UPDATE uploads SET status = 'processed' WHERE id = $1`, [uploadId]); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK"); throw error; } await audit(req, "dataset.processed", 200, "upload", uploadId, { normalizedRecordCount: records.length }); res.json({ success: true, uploadId, normalizedRecordCount: records.length }); });
app.get("/api/v1/admin/audit", requireSession, requireRole("platform_admin", "tenant_admin"), async (req: AuthenticatedRequest, res) => { const client = getPool(); if (!client) return res.status(503).json({ error: "DATABASE_UNAVAILABLE" }); const result = await client.query(`SELECT occurred_at, action, severity, resource_type, resource_id, status_code, request_id FROM audit_events ORDER BY occurred_at DESC LIMIT 250`); await audit(req, "audit.center.viewed", 200, "audit_event"); res.json({ events: result.rows }); });
app.post("/api/v1/admin/reports", requireSession, requireRole("platform_admin", "tenant_admin", "analyst"), async (req: AuthenticatedRequest, res) => { const parsed = reportSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_REPORT_REQUEST" }); const client = getPool(); if (!client) return res.status(503).json({ error: "DATABASE_UNAVAILABLE" }); const id = randomUUID(); await client.query(`INSERT INTO reports (id, title, description, layout_config, status, created_by) VALUES ($1,$2,$3,$4,'draft',$5)`, [id, parsed.data.title, parsed.data.description ?? null, JSON.stringify(parsed.data.layoutConfig), req.session!.sub]); await audit(req, "report.created", 201, "report", id, { title: parsed.data.title }); res.status(201).json({ id, status: "draft" }); });
app.post("/api/v1/admin/reports/:id/publish", requireSession, requireRole("platform_admin", "tenant_admin"), async (req: AuthenticatedRequest, res) => { const reportId = scalarRouteParam(req.params.id); if (!reportId) return res.status(400).json({ error: "INVALID_REPORT_ID" }); const parsed = publicationSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_PUBLICATION_REQUEST" }); if (req.session!.role === "tenant_admin" && (parsed.data.tenantIds.length !== 1 || parsed.data.tenantIds[0] !== req.session!.tenantId)) return res.status(403).json({ error: "TENANT_SCOPE_VIOLATION" }); const client = getPool(); if (!client) return res.status(503).json({ error: "DATABASE_UNAVAILABLE" }); const report = await client.query<{ id: string }>(`SELECT id FROM reports WHERE id = $1 LIMIT 1`, [reportId]); if (!report.rows[0]) return res.status(404).json({ error: "REPORT_NOT_FOUND" }); await client.query("BEGIN"); try { await client.query(`UPDATE reports SET status = 'published', published_at = now(), version = version + 1, updated_at = now() WHERE id = $1`, [reportId]); for (const tenantId of parsed.data.tenantIds) await client.query(`INSERT INTO report_publications (id, report_id, tenant_id, authorized_periods, published_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (report_id, tenant_id) DO UPDATE SET authorized_periods = EXCLUDED.authorized_periods, published_by = EXCLUDED.published_by, published_at = now()`, [randomUUID(), reportId, tenantId, JSON.stringify(parsed.data.authorizedPeriods), req.session!.sub]); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK"); throw error; } await audit(req, "report.published", 200, "report", reportId, { tenantCount: parsed.data.tenantIds.length, authorizedPeriods: parsed.data.authorizedPeriods }); res.json({ success: true, reportId }); });
app.get("/api/v1/reports", requireSession, async (req: AuthenticatedRequest, res) => { const client = getPool(); if (!client) return res.status(503).json({ error: "DATABASE_UNAVAILABLE" }); const privileged = ["platform_admin", "tenant_admin", "analyst"].includes(req.session!.role); const query = privileged ? `SELECT id, title, description, status, version, published_at FROM reports WHERE status = 'published' ORDER BY published_at DESC LIMIT 100` : `SELECT r.id, r.title, r.description, r.status, r.version, r.published_at, p.authorized_periods FROM reports r INNER JOIN report_publications p ON p.report_id = r.id WHERE r.status = 'published' AND p.tenant_id = $1 ORDER BY r.published_at DESC LIMIT 100`; const result = await client.query(query, privileged ? [] : [req.session!.tenantId]); await audit(req, "report.catalog.viewed", 200, "report_catalog"); res.json({ reports: result.rows }); });
app.post("/api/v1/admin/siem/validate", requireSession, requireRole("platform_admin"), async (req: AuthenticatedRequest, res) => { const parsed = siemSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_SIEM_CONFIGURATION" }); const allowedHosts = (process.env.SIEM_ALLOWED_HOSTS || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean); if (!allowedHosts.includes(parsed.data.hostname.toLowerCase())) { await audit(req, "siem.configuration.rejected", 403, "siem", null, { protocol: parsed.data.protocol, hostname: parsed.data.hostname }); return res.status(403).json({ error: "SIEM_HOST_NOT_ALLOWLISTED" }); } await audit(req, "siem.configuration.validated", 200, "siem", null, { protocol: parsed.data.protocol, hostname: parsed.data.hostname, port: parsed.data.port }); res.json({ valid: true, message: "The endpoint is allowlisted. Store credentials in the deployment secret manager before enabling forwarding." }); });

app.use((error: unknown, req: LoggedRequest, res: Response, _next: NextFunction) => { const message = error instanceof Error ? error.message : "Unhandled error"; writeLog("error", "http.unhandled_error", { requestId: req.requestId, path: req.path, error: message }); void recordAudit({ requestId: req.requestId ?? "unknown", action: "system.request.error", severity: "critical", resourceType: "request", ipHash: req.ipHash ?? "unknown", method: req.method, statusCode: 500, metadata: { errorClass: error instanceof Error ? error.name : "UnknownError" } }); res.status(500).json({ error: "REQUEST_FAILED", requestId: req.requestId }); });

async function start() {
  if (process.env.NODE_ENV === "production") {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const publicDir = path.resolve(root, "public");
    const brandingDir = path.resolve(root, "..", "branding");
    app.use("/assets/branding", express.static(brandingDir, { fallthrough: false, immutable: true, maxAge: "30d", etag: true }));
    app.use(express.static(publicDir, { index: false, fallthrough: true, maxAge: "1h", etag: true }));
    app.use((_req, res) => res.sendFile(path.join(publicDir, "index.html")));
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  }
  const port = Number(process.env.PORT || 3000);
  createServer(app).listen(port, () => {
    writeLog("info", "server.started", { environment: process.env.NODE_ENV ?? "development", port });
    console.log(`Server running on http://localhost:${port}`);
  });
}

start().catch(error => { writeLog("error", "server.start.failed", { error: error instanceof Error ? error.message : "Unknown error" }); process.exit(1); });
