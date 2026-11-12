import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canManageTarget, canonicalRole, verifyPassword, COMPROMISED_LEGACY_PASSWORDS, type Role } from "./security";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.resolve(__dirname, "..", "data");
if (process.env.DATA_DIR && !path.isAbsolute(process.env.DATA_DIR)) throw new Error("DATA_DIR must be an absolute path.");
if (process.env.SQLITE_PATH && !path.isAbsolute(process.env.SQLITE_PATH)) throw new Error("SQLITE_PATH must be an absolute path.");
mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.SQLITE_PATH || path.join(dataDir, "portal.db");

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      password_hash TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      session_version INTEGER NOT NULL DEFAULT 0,
      auth_provider TEXT NOT NULL DEFAULT 'local',
      sso_id TEXT,
      mfa_required INTEGER NOT NULL DEFAULT 1,
      mfa_secret_encrypted TEXT,
      mfa_enrolled_at TEXT,
      mfa_recovery_codes TEXT,
      locked_until TEXT,
      failed_sign_in_count INTEGER NOT NULL DEFAULT 0,
      last_signed_in_at TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL COLLATE NOCASE,
      role TEXT NOT NULL,
      tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS monthly_metrics (
      id TEXT PRIMARY KEY,
      tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
      reporting_month INTEGER NOT NULL,
      reporting_year INTEGER NOT NULL,
      calls_round1 INTEGER NOT NULL DEFAULT 0,
      calls_round2 INTEGER NOT NULL DEFAULT 0,
      calls_round3 INTEGER NOT NULL DEFAULT 0,
      aca_yes INTEGER NOT NULL DEFAULT 0,
      aca_no INTEGER NOT NULL DEFAULT 0,
      head_of_household INTEGER NOT NULL DEFAULT 0,
      staff_members INTEGER NOT NULL DEFAULT 0,
      calls_jhpp INTEGER NOT NULL DEFAULT 0,
      calls_wr INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      entered_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, reporting_year, reporting_month)
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT,
      reporting_year INTEGER,
      reporting_month INTEGER,
      layout_config TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      version INTEGER NOT NULL DEFAULT 1,
      publish_target TEXT NOT NULL DEFAULT 'all',
      published_at TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS report_user_assignments (
      report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (report_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      actor_role TEXT,
      actor_email TEXT,
      tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      ip_hash TEXT NOT NULL,
      real_ip TEXT,
      geo_country TEXT,
      user_agent TEXT,
      method TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      before_state TEXT,
      after_state TEXT,
      metadata TEXT,
      occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mail_logs (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      recipient TEXT NOT NULL,
      bcc TEXT,
      subject TEXT NOT NULL,
      payload TEXT,
      status TEXT NOT NULL,
      error TEXT,
      correlation_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS email_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      primary_provider TEXT NOT NULL DEFAULT 'smtp',
      secondary_provider TEXT,
      smtp_host TEXT,
      smtp_port INTEGER DEFAULT 587,
      smtp_secure INTEGER DEFAULT 0,
      smtp_user TEXT,
      smtp_pass TEXT,
      smtp_from TEXT,
      graph_client_id TEXT,
      graph_client_secret TEXT,
      graph_tenant_id TEXT,
      graph_sender TEXT,
      global_bcc TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS siem_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      syslog_host TEXT,
      syslog_port INTEGER DEFAULT 514,
      syslog_protocol TEXT DEFAULT 'udp',
      syslog_facility INTEGER DEFAULT 16,
      syslog_enabled INTEGER DEFAULT 0,
      webhook_url TEXT,
      webhook_token TEXT,
      webhook_format TEXT DEFAULT 'generic',
      webhook_enabled INTEGER DEFAULT 0,
      allowed_hosts TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS siem_buffer (
      id TEXT PRIMARY KEY,
      event_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS entra_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tenant_id TEXT,
      client_id TEXT,
      client_secret TEXT,
      redirect_uri TEXT,
      issuer TEXT,
      saml_metadata_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS brand_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      company_name TEXT NOT NULL DEFAULT 'Welfare Pride',
      tagline TEXT NOT NULL DEFAULT 'Health Plan Outreach Reporting Portal',
      logo_url TEXT DEFAULT '/assets/branding/welfare-pride-main-logo.webp',
      logo_dark_url TEXT,
      icon_url TEXT DEFAULT '/assets/branding/welfare-pride-icon.png',
      favicon_url TEXT DEFAULT '/assets/branding/welfare-pride-icon.png',
      primary_color TEXT NOT NULL DEFAULT '#5A92C9',
      secondary_color TEXT NOT NULL DEFAULT '#D58240',
      font_family TEXT NOT NULL DEFAULT 'WelfareRoboto',
      email_header_text TEXT DEFAULT 'Welfare Pride · Secure Reporting Portal',
      default_theme TEXT NOT NULL DEFAULT 'system',
      allow_theme_override INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ip_rules (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      reason TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      encrypted INTEGER NOT NULL DEFAULT 0,
      checksum TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_events(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(action);
    CREATE INDEX IF NOT EXISTS idx_metrics_period ON monthly_metrics(reporting_year DESC, reporting_month DESC);
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
  `);
  // Additive migration; preserve users, tenant data, and existing password hashes.
  const columns = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  db.transaction(() => {
    if (!columns.some(c => c.name === "must_change_password")) db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
    if (!columns.some(c => c.name === "session_version")) {
      db.exec("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0");
      // Revoke all legacy tokens, which do not prove the current MFA/reset state.
      db.exec("UPDATE users SET session_version = 1");
    }
    db.exec("CREATE TABLE IF NOT EXISTS security_migrations (name TEXT PRIMARY KEY)");
  })();
  // Seed configuration singletons only; never seed accounts or sample records.
  db.exec(`
    INSERT OR IGNORE INTO email_config (id) VALUES (1);
    INSERT OR IGNORE INTO siem_config (id) VALUES (1);
    INSERT OR IGNORE INTO entra_config (id) VALUES (1);
    INSERT OR IGNORE INTO brand_config (id) VALUES (1);
  `);
}

// ---------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------
export type DbUser = {
  id: string;
  tenant_id: string | null;
  email: string;
  display_name: string;
  role: Role;
  status: "invited" | "active" | "disabled" | "locked";
  password_hash: string | null;
  must_change_password: number;
  session_version: number;
  auth_provider: "local" | "sso";
  sso_id: string | null;
  mfa_required: number;
  mfa_secret_encrypted: string | null;
  mfa_enrolled_at: string | null;
  mfa_recovery_codes: string | null;
  locked_until: string | null;
  failed_sign_in_count: number;
  last_signed_in_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export function findUserByEmail(email: string): DbUser | null {
  const row = db.prepare(`SELECT * FROM users WHERE lower(email) = lower(?) LIMIT 1`).get(email.trim());
  if (!row) return null;
  return { ...(row as DbUser), role: canonicalRole((row as DbUser).role) };
}

export function findUserById(id: string): DbUser | null {
  const row = db.prepare(`SELECT * FROM users WHERE id = ? LIMIT 1`).get(id);
  if (!row) return null;
  return { ...(row as DbUser), role: canonicalRole((row as DbUser).role) };
}

export function listUsers(actorRole: Role, tenantId?: string | null): DbUser[] {
  let rows: DbUser[];
  if (tenantId) {
    rows = db.prepare(`SELECT * FROM users WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 500`).all(tenantId) as DbUser[];
  } else {
    rows = db.prepare(`SELECT * FROM users ORDER BY created_at DESC LIMIT 500`).all() as DbUser[];
  }
  return rows
    .map(u => ({ ...u, role: canonicalRole(u.role) }))
    // Super Admin isolation: non-super-admins cannot see super_admins
    .filter(u => actorRole === "super_admin" || u.role !== "super_admin");
}

export function createUser(input: {
  tenantId: string | null;
  email: string;
  displayName: string;
  role: Role;
  passwordHash: string | null;
  authProvider?: "local" | "sso";
  mfaRequired?: boolean;
  status?: DbUser["status"];
  createdBy?: string | null;
  mustChangePassword?: boolean;
}): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO users (id, tenant_id, email, display_name, role, password_hash, auth_provider, mfa_required, status, created_by, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.tenantId,
    input.email.trim(),
    input.displayName.trim(),
    input.role,
    input.passwordHash,
    input.authProvider ?? "local",
    input.mfaRequired ?? true ? 1 : 0,
    input.status ?? "invited",
    input.createdBy ?? null,
    input.mustChangePassword ? 1 : 0,
  );
  return id;
}

export function updateUser(id: string, fields: Partial<{
  displayName: string;
  role: Role;
  status: DbUser["status"];
  mfaRequired: boolean;
  authProvider: "local" | "sso";
  ssoId: string | null;
  tenantId: string | null;
}>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const securityChanges: string[] = [];
  const securityValues: unknown[] = [];
  const securityField = (column: string, value: unknown) => {
    securityChanges.push(`${column} IS NOT ?`);
    securityValues.push(value);
  };
  if (fields.displayName !== undefined) { sets.push("display_name = ?"); vals.push(fields.displayName); }
  if (fields.role !== undefined) { sets.push("role = ?"); vals.push(fields.role); securityField("role", fields.role); }
  if (fields.status !== undefined) { sets.push("status = ?"); vals.push(fields.status); securityField("status", fields.status); }
  if (fields.mfaRequired !== undefined) { const v = fields.mfaRequired ? 1 : 0; sets.push("mfa_required = ?"); vals.push(v); securityField("mfa_required", v); }
  if (fields.authProvider !== undefined) { sets.push("auth_provider = ?"); vals.push(fields.authProvider); securityField("auth_provider", fields.authProvider); }
  if (fields.ssoId !== undefined) { sets.push("sso_id = ?"); vals.push(fields.ssoId); securityField("sso_id", fields.ssoId); }
  if (fields.tenantId !== undefined) { sets.push("tenant_id = ?"); vals.push(fields.tenantId); securityField("tenant_id", fields.tenantId); }
  if (sets.length === 0) return;
  if (securityChanges.length) {
    sets.push(`session_version = session_version + CASE WHEN ${securityChanges.join(" OR ")} THEN 1 ELSE 0 END`);
    vals.push(...securityValues);
  }
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function disableUser(id: string): void {
  db.prepare(`UPDATE users SET session_version = session_version + CASE WHEN status != 'disabled' THEN 1 ELSE 0 END, status = 'disabled', updated_at = datetime('now') WHERE id = ?`).run(id);
}
export function enableUser(id: string): void {
  db.prepare(`UPDATE users SET session_version = session_version + CASE WHEN status != 'active' THEN 1 ELSE 0 END, status = 'active', locked_until = NULL, failed_sign_in_count = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
}

// Compare-and-swap prevents a request using a stale token from revoking newer sessions.
export function revokeSessions(id: string, version: number): boolean {
  return db.prepare(`UPDATE users SET session_version = session_version + 1, updated_at = datetime('now') WHERE id = ? AND session_version = ?`).run(id, version).changes === 1;
}

export function updatePassword(id: string, hash: string): void {
  db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, session_version = session_version + 1, status = 'active', locked_until = NULL, failed_sign_in_count = 0, updated_at = datetime('now') WHERE id = ? AND status != 'disabled'`).run(hash, id);
}

export function changePasswordForSession(id: string, version: number, oldHash: string, newHash: string): boolean {
  return db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, session_version = session_version + 1, locked_until = NULL, failed_sign_in_count = 0, updated_at = datetime('now') WHERE id = ? AND session_version = ? AND password_hash = ? AND status = 'active'`).run(newHash, id, version, oldHash).changes === 1;
}

export function completeRequiredPasswordChange(id: string, version: number, oldHash: string, newHash: string): boolean {
  return db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, session_version = session_version + 1, status = 'active', updated_at = datetime('now') WHERE id = ? AND session_version = ? AND password_hash = ? AND must_change_password = 1 AND status != 'disabled'`).run(newHash, id, version, oldHash).changes === 1;
}

export function markSignInFailure(id: string): void {
  db.prepare(`
    UPDATE users SET
      failed_sign_in_count = failed_sign_in_count + 1,
      locked_until = CASE WHEN failed_sign_in_count + 1 >= 5 THEN datetime('now', '+15 minutes') ELSE locked_until END,
      session_version = session_version + CASE WHEN failed_sign_in_count + 1 >= 5 AND status != 'locked' THEN 1 ELSE 0 END,
      status = CASE WHEN failed_sign_in_count + 1 >= 5 THEN 'locked' ELSE status END,
      updated_at = datetime('now')
    WHERE id = ? AND status != 'disabled'
  `).run(id);
}

export function markSignInSuccess(id: string): void {
  db.prepare(`UPDATE users SET failed_sign_in_count = 0, locked_until = NULL, session_version = session_version + CASE WHEN status = 'locked' THEN 1 ELSE 0 END, status = CASE WHEN status = 'locked' THEN 'active' ELSE status END, last_signed_in_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status != 'disabled'`).run(id);
}

export function setMfaSecret(id: string, encryptedSecret: string): void {
  db.prepare(`UPDATE users SET mfa_secret_encrypted = ?, mfa_enrolled_at = NULL, updated_at = datetime('now') WHERE id = ? AND mfa_enrolled_at IS NULL`).run(encryptedSecret, id);
}

export function setMfaRecoveryCodes(id: string, hashedCodesJson: string): void {
  db.prepare(`UPDATE users SET mfa_recovery_codes = ?, mfa_enrolled_at = datetime('now'), session_version = session_version + CASE WHEN status != 'active' THEN 1 ELSE 0 END, status = 'active', updated_at = datetime('now') WHERE id = ? AND status IN ('active', 'invited')`).run(hashedCodesJson, id);
}

export function consumeMfaRecoveryCode(id: string, codeHash: string): boolean {
  const user = findUserById(id);
  if (!user?.mfa_recovery_codes) return false;
  try {
    const codes: string[] = JSON.parse(user.mfa_recovery_codes);
    const idx = codes.indexOf(codeHash);
    if (idx === -1) return false;
    codes.splice(idx, 1);
    db.prepare(`UPDATE users SET mfa_recovery_codes = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(codes), id);
    return true;
  } catch {
    return false;
  }
}

export function resetUserMfa(id: string): void {
  db.prepare(`UPDATE users SET mfa_secret_encrypted = NULL, mfa_enrolled_at = NULL, mfa_recovery_codes = NULL, session_version = session_version + 1, updated_at = datetime('now') WHERE id = ?`).run(id);
}

// ---------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------
export type Tenant = { id: string; name: string; created_at: string };
export function listTenants(): Tenant[] {
  return db.prepare(`SELECT * FROM tenants ORDER BY name ASC`).all() as Tenant[];
}
export function ensureDefaultTenant(name = "Welfare Pride"): string {
  const row = db.prepare(`SELECT id FROM tenants WHERE lower(name) = lower(?)`).get(name) as { id: string } | undefined;
  if (row) return row.id;
  const id = randomUUID();
  db.prepare(`INSERT INTO tenants (id, name) VALUES (?, ?)`).run(id, name);
  return id;
}

// ---------------------------------------------------------------------
// Invitations & Password Resets
// ---------------------------------------------------------------------
export type Invitation = { id: string; email: string; role: Role; tenant_id: string | null; token: string; expires_at: string; used_at: string | null; created_by: string | null; created_at: string };
export function createInvitation(email: string, role: Role, tenantId: string | null, createdBy: string | null, ttlHours = 72): Invitation {
  const id = randomUUID();
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO invitations (id, email, role, tenant_id, token, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, email.trim(), role, tenantId, token, expiresAt, createdBy);
  return db.prepare(`SELECT * FROM invitations WHERE id = ?`).get(id) as Invitation;
}
export function findInvitation(token: string): Invitation | null {
  return (db.prepare(`SELECT * FROM invitations WHERE token = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')`).get(token) as Invitation) || null;
}
export function consumeInvitation(token: string): void {
  db.prepare(`UPDATE invitations SET used_at = datetime('now') WHERE token = ?`).run(token);
}

export function createPasswordReset(userId: string, ttlMinutes = 60): string {
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO password_resets (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)`).run(randomUUID(), userId, token, expiresAt);
  return token;
}
export function findPasswordReset(token: string): { user_id: string } | null {
  return (db.prepare(`SELECT user_id FROM password_resets WHERE token = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')`).get(token) as { user_id: string }) || null;
}
export function consumePasswordReset(token: string): void {
  db.prepare(`UPDATE password_resets SET used_at = datetime('now') WHERE token = ?`).run(token);
}

// ---------------------------------------------------------------------
// Monthly Metrics (the exact 9 fields + month + year)
// ---------------------------------------------------------------------
export type MonthlyMetric = {
  id: string;
  tenant_id: string | null;
  reporting_month: number;
  reporting_year: number;
  calls_round1: number;
  calls_round2: number;
  calls_round3: number;
  aca_yes: number;
  aca_no: number;
  head_of_household: number;
  staff_members: number;
  calls_jhpp: number;
  calls_wr: number;
  notes: string | null;
  entered_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ComputedKpi = {
  totalCalls: number;
  round1Rate: number;
  round2Rate: number;
  round3Rate: number;
  totalAca: number;
  acaRate: number;
  callsPerStaff: number;
  totalReferrals: number;
  jhppShare: number;
  wrShare: number;
};

export function computeKpis(m: MonthlyMetric): ComputedKpi {
  const totalCalls = m.calls_round1 + m.calls_round2 + m.calls_round3;
  const totalAca = m.aca_yes + m.aca_no;
  const totalReferrals = m.calls_jhpp + m.calls_wr;
  return {
    totalCalls,
    round1Rate: totalCalls ? Math.round((m.calls_round1 / totalCalls) * 1000) / 10 : 0,
    round2Rate: totalCalls ? Math.round((m.calls_round2 / totalCalls) * 1000) / 10 : 0,
    round3Rate: totalCalls ? Math.round((m.calls_round3 / totalCalls) * 1000) / 10 : 0,
    totalAca,
    acaRate: totalAca ? Math.round((m.aca_yes / totalAca) * 1000) / 10 : 0,
    callsPerStaff: m.staff_members ? Math.round((totalCalls / m.staff_members) * 10) / 10 : 0,
    totalReferrals,
    jhppShare: totalReferrals ? Math.round((m.calls_jhpp / totalReferrals) * 1000) / 10 : 0,
    wrShare: totalReferrals ? Math.round((m.calls_wr / totalReferrals) * 1000) / 10 : 0,
  };
}

export function listMonthlyMetrics(year?: number, tenantId?: string | null): MonthlyMetric[] {
  let q = `SELECT * FROM monthly_metrics WHERE 1=1`;
  const params: unknown[] = [];
  if (year) { q += ` AND reporting_year = ?`; params.push(year); }
  if (tenantId !== undefined) { q += ` AND tenant_id = ?`; params.push(tenantId); }
  q += ` ORDER BY reporting_year DESC, reporting_month DESC`;
  return db.prepare(q).all(...params) as MonthlyMetric[];
}

export function findMonthlyMetric(year: number, month: number, tenantId?: string | null): MonthlyMetric | null {
  const row = db.prepare(`SELECT * FROM monthly_metrics WHERE reporting_year = ? AND reporting_month = ? AND (tenant_id = ? OR (tenant_id IS NULL AND ? IS NULL)) LIMIT 1`).get(year, month, tenantId ?? null, tenantId ?? null);
  return (row as MonthlyMetric) || null;
}

export function upsertMonthlyMetric(input: {
  tenantId: string | null;
  reporting_month: number;
  reporting_year: number;
  calls_round1: number;
  calls_round2: number;
  calls_round3: number;
  aca_yes: number;
  aca_no: number;
  head_of_household: number;
  staff_members: number;
  calls_jhpp: number;
  calls_wr: number;
  notes?: string | null;
  entered_by?: string | null;
}): MonthlyMetric {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO monthly_metrics (id, tenant_id, reporting_month, reporting_year, calls_round1, calls_round2, calls_round3, aca_yes, aca_no, head_of_household, staff_members, calls_jhpp, calls_wr, notes, entered_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, reporting_year, reporting_month) DO UPDATE SET
      calls_round1 = excluded.calls_round1,
      calls_round2 = excluded.calls_round2,
      calls_round3 = excluded.calls_round3,
      aca_yes = excluded.aca_yes,
      aca_no = excluded.aca_no,
      head_of_household = excluded.head_of_household,
      staff_members = excluded.staff_members,
      calls_jhpp = excluded.calls_jhpp,
      calls_wr = excluded.calls_wr,
      notes = excluded.notes,
      entered_by = excluded.entered_by,
      updated_at = datetime('now')
  `).run(
    id,
    input.tenantId,
    input.reporting_month,
    input.reporting_year,
    Math.max(0, input.calls_round1 || 0),
    Math.max(0, input.calls_round2 || 0),
    Math.max(0, input.calls_round3 || 0),
    Math.max(0, input.aca_yes || 0),
    Math.max(0, input.aca_no || 0),
    Math.max(0, input.head_of_household || 0),
    Math.max(0, input.staff_members || 0),
    Math.max(0, input.calls_jhpp || 0),
    Math.max(0, input.calls_wr || 0),
    input.notes ?? null,
    input.entered_by ?? null,
  );
  return db.prepare(`SELECT * FROM monthly_metrics WHERE reporting_year = ? AND reporting_month = ? AND (tenant_id = ? OR (tenant_id IS NULL AND ? IS NULL)) LIMIT 1`).get(input.reporting_year, input.reporting_month, input.tenantId, input.tenantId) as MonthlyMetric;
}

export function listAvailableYears(tenantId?: string | null): number[] {
  const rows = (tenantId === undefined
    ? db.prepare(`SELECT DISTINCT reporting_year FROM monthly_metrics ORDER BY reporting_year DESC`).all()
    : db.prepare(`SELECT DISTINCT reporting_year FROM monthly_metrics WHERE tenant_id = ? ORDER BY reporting_year DESC`).all(tenantId)) as { reporting_year: number }[];
  return rows.map(r => r.reporting_year);
}

// ---------------------------------------------------------------------
// Reports & Publishing
// ---------------------------------------------------------------------
export type Report = {
  id: string;
  tenant_id: string | null;
  title: string;
  description: string | null;
  reporting_year: number | null;
  reporting_month: number | null;
  layout_config: string | null;
  status: "draft" | "published" | "hidden";
  version: number;
  publish_target: "all" | "specific_users" | "view_users";
  published_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export function listReports(actor: { id: string; role: Role; tenantId: string | null }, opts?: { year?: number; status?: string; search?: string }): (Report & { creator_name?: string })[] {
  let q = `SELECT r.*, u.display_name AS creator_name FROM reports r LEFT JOIN users u ON u.id = r.created_by WHERE 1=1`;
  const params: unknown[] = [];
  q += ` AND r.tenant_id = ?`;
  params.push(actor.tenantId);
  if (actor.role === "view_only") {
    q += ` AND r.status = 'published' AND (
      r.publish_target IN ('all','view_users')
      OR (r.publish_target = 'specific_users' AND EXISTS (SELECT 1 FROM report_user_assignments a WHERE a.report_id = r.id AND a.user_id = ?))
    )`;
    params.push(actor.id);
  }
  if (opts?.status) { q += ` AND r.status = ?`; params.push(opts.status); }
  if (opts?.year) { q += ` AND r.reporting_year = ?`; params.push(opts.year); }
  if (opts?.search) { q += ` AND (r.title LIKE ? OR r.description LIKE ?)`; params.push(`%${opts.search}%`, `%${opts.search}%`); }
  q += ` ORDER BY r.created_at DESC LIMIT 200`;
  return db.prepare(q).all(...params) as (Report & { creator_name?: string })[];
}

export function findReport(id: string): Report | null {
  return (db.prepare(`SELECT * FROM reports WHERE id = ? LIMIT 1`).get(id) as Report) || null;
}

export function getReportAssignments(reportId: string): string[] {
  const rows = db.prepare(`SELECT user_id FROM report_user_assignments WHERE report_id = ?`).all(reportId) as { user_id: string }[];
  return rows.map(r => r.user_id);
}

export function setReportAssignments(reportId: string, userIds: string[]): void {
  db.prepare(`DELETE FROM report_user_assignments WHERE report_id = ?`).run(reportId);
  const insert = db.prepare(`INSERT OR IGNORE INTO report_user_assignments (report_id, user_id) VALUES (?, ?)`);
  const tx = db.transaction((ids: string[]) => { for (const uid of ids) insert.run(reportId, uid); });
  tx(userIds);
}

export function createReport(input: {
  tenantId: string | null;
  title: string;
  description?: string | null;
  reporting_year?: number | null;
  reporting_month?: number | null;
  layout_config?: string | null;
  created_by?: string | null;
}): Report {
  const id = randomUUID();
  db.prepare(`INSERT INTO reports (id, tenant_id, title, description, reporting_year, reporting_month, layout_config, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, input.tenantId, input.title.trim(), input.description ?? null, input.reporting_year ?? null, input.reporting_month ?? null, input.layout_config ?? null, input.created_by ?? null,
  );
  return db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id) as Report;
}

export function updateReport(id: string, fields: Partial<{
  title: string;
  description: string | null;
  reporting_year: number | null;
  reporting_month: number | null;
  layout_config: string | null;
}>): Report {
  const current = findReport(id);
  if (!current) throw new Error("Report not found");
  const bump = current.status === "published" ? 1 : 0;
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.title !== undefined) { sets.push("title = ?"); vals.push(fields.title.trim()); }
  if (fields.description !== undefined) { sets.push("description = ?"); vals.push(fields.description); }
  if (fields.reporting_year !== undefined) { sets.push("reporting_year = ?"); vals.push(fields.reporting_year); }
  if (fields.reporting_month !== undefined) { sets.push("reporting_month = ?"); vals.push(fields.reporting_month); }
  if (fields.layout_config !== undefined) { sets.push("layout_config = ?"); vals.push(fields.layout_config); }
  if (sets.length === 0) return current;
  if (bump) { sets.push("version = version + 1"); }
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE reports SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id) as Report;
}

export function publishReport(id: string, target: "all" | "specific_users" | "view_users", userIds?: string[]): Report {
  db.transaction(() => {
    db.prepare(`UPDATE reports SET status = 'published', publish_target = ?, published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(target, id);
    setReportAssignments(id, target === "specific_users" ? userIds ?? [] : []);
  })();
  return db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id) as Report;
}

export function hideReport(id: string): Report {
  db.prepare(`UPDATE reports SET status = 'hidden', updated_at = datetime('now') WHERE id = ?`).run(id);
  return db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id) as Report;
}

export function deleteReport(id: string): void {
  db.prepare(`DELETE FROM reports WHERE id = ?`).run(id);
}

// ---------------------------------------------------------------------
// Audit Events
// ---------------------------------------------------------------------
export type AuditEventRow = {
  id: string;
  request_id: string;
  actor_id: string | null;
  actor_role: string | null;
  actor_email: string | null;
  tenant_id: string | null;
  action: string;
  severity: string;
  resource_type: string;
  resource_id: string | null;
  ip_hash: string;
  real_ip: string | null;
  geo_country: string | null;
  user_agent: string | null;
  method: string;
  status_code: number;
  before_state: string | null;
  after_state: string | null;
  metadata: string | null;
  occurred_at: string;
};

export function insertAuditEvent(ev: {
  requestId: string;
  actorId?: string | null;
  actorRole?: string | null;
  actorEmail?: string | null;
  tenantId?: string | null;
  action: string;
  severity?: string;
  resourceType: string;
  resourceId?: string | null;
  ipHash: string;
  realIp?: string | null;
  geoCountry?: string | null;
  userAgent?: string | null;
  method: string;
  statusCode: number;
  beforeState?: object | null;
  afterState?: object | null;
  metadata?: object;
}): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO audit_events (id, request_id, actor_id, actor_role, actor_email, tenant_id, action, severity, resource_type, resource_id, ip_hash, real_ip, geo_country, user_agent, method, status_code, before_state, after_state, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    ev.requestId,
    ev.actorId ?? null,
    ev.actorRole ?? null,
    ev.actorEmail ?? null,
    ev.tenantId ?? null,
    ev.action,
    ev.severity ?? "info",
    ev.resourceType,
    ev.resourceId ?? null,
    ev.ipHash,
    ev.realIp ?? null,
    ev.geoCountry ?? null,
    ev.userAgent?.slice(0, 512) ?? null,
    ev.method,
    ev.statusCode,
    ev.beforeState ? JSON.stringify(ev.beforeState) : null,
    ev.afterState ? JSON.stringify(ev.afterState) : null,
    JSON.stringify(ev.metadata ?? {}),
  );
  return id;
}

export function listAuditEvents(opts?: {
  tenantId?: string | null;
  actor?: string;
  action?: string;
  severity?: string;
  resourceType?: string;
  correlationId?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): { events: AuditEventRow[]; total: number } {
  let where = `WHERE 1=1`;
  const params: unknown[] = [];
  // Undefined means explicitly global; null never matches a tenant and fails closed.
  if (opts?.tenantId !== undefined) { where += ` AND tenant_id = ?`; params.push(opts.tenantId); }
  if (opts?.actor) { where += ` AND (actor_id = ? OR actor_email LIKE ?)`; params.push(opts.actor, `%${opts.actor}%`); }
  if (opts?.action) { where += ` AND action LIKE ?`; params.push(`%${opts.action}%`); }
  if (opts?.severity) { where += ` AND severity = ?`; params.push(opts.severity); }
  if (opts?.resourceType) { where += ` AND resource_type = ?`; params.push(opts.resourceType); }
  if (opts?.correlationId) { where += ` AND request_id LIKE ?`; params.push(`%${opts.correlationId}%`); }
  if (opts?.from) { where += ` AND datetime(occurred_at) >= datetime(?)`; params.push(opts.from); }
  if (opts?.to) { where += ` AND datetime(occurred_at) <= datetime(?)`; params.push(opts.to); }
  if (opts?.search) {
    where += ` AND (action LIKE ? OR actor_email LIKE ? OR real_ip LIKE ? OR resource_type LIKE ? OR request_id LIKE ? OR metadata LIKE ?)`;
    const s = `%${opts.search}%`;
    params.push(s, s, s, s, s, s);
  }
  const countRow = db.prepare(`SELECT COUNT(*) AS total FROM audit_events ${where}`).get(...params) as { total: number };
  const limit = Math.min(Math.max(1, opts?.limit ?? 50), 500);
  const offset = Math.max(0, opts?.offset ?? 0);
  const events = db.prepare(`SELECT * FROM audit_events ${where} ORDER BY occurred_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as AuditEventRow[];
  return { events, total: countRow.total };
}

// ---------------------------------------------------------------------
// Mail logs & config
// ---------------------------------------------------------------------
export type MailLog = {
  id: string;
  provider: string;
  recipient: string;
  bcc: string | null;
  subject: string;
  payload: string | null;
  status: "sent" | "failed" | "simulated" | "unknown";
  error: string | null;
  correlation_id: string | null;
  created_at: string;
};

export function logMail(entry: { provider: string; recipient: string; bcc?: string | null; subject: string; payload?: string | null; status: "sent" | "failed" | "simulated" | "unknown"; error?: string | null; correlation_id?: string | null }): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO mail_logs (id, provider, recipient, bcc, subject, payload, status, error, correlation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, entry.provider, entry.recipient, entry.bcc ?? null, entry.subject, entry.payload ?? null, entry.status, entry.error ?? null, entry.correlation_id ?? null,
  );
  return id;
}

export function listMailLogs(limit = 100): MailLog[] {
  return db.prepare(`SELECT * FROM mail_logs ORDER BY created_at DESC LIMIT ?`).all(limit) as MailLog[];
}
export function findMailLog(id: string): MailLog | null {
  return (db.prepare(`SELECT * FROM mail_logs WHERE id = ?`).get(id) as MailLog) || null;
}

export type EmailConfig = {
  primary_provider: string;
  secondary_provider: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: number | null;
  smtp_user: string | null;
  smtp_pass: string | null;
  smtp_from: string | null;
  graph_client_id: string | null;
  graph_client_secret: string | null;
  graph_tenant_id: string | null;
  graph_sender: string | null;
  global_bcc: string | null;
  enabled: number;
};
export function getEmailConfig(): EmailConfig {
  return db.prepare(`SELECT * FROM email_config WHERE id = 1`).get() as EmailConfig;
}
export function updateEmailConfig(c: Partial<EmailConfig>): EmailConfig {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(c)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    db.prepare(`UPDATE email_config SET ${sets.join(", ")} WHERE id = 1`).run(...vals);
  }
  return getEmailConfig();
}

// ---------------------------------------------------------------------
// SIEM config & retry buffer
// ---------------------------------------------------------------------
export type SiemConfig = {
  syslog_host: string | null;
  syslog_port: number | null;
  syslog_protocol: string | null;
  syslog_facility: number | null;
  syslog_enabled: number;
  webhook_url: string | null;
  webhook_token: string | null;
  webhook_format: string | null;
  webhook_enabled: number;
  allowed_hosts: string | null;
};
export function getSiemConfig(): SiemConfig {
  return db.prepare(`SELECT * FROM siem_config WHERE id = 1`).get() as SiemConfig;
}
export function updateSiemConfig(c: Partial<SiemConfig>): SiemConfig {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(c)) { sets.push(`${k} = ?`); vals.push(v); }
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    db.prepare(`UPDATE siem_config SET ${sets.join(", ")} WHERE id = 1`).run(...vals);
  }
  return getSiemConfig();
}
export function enqueueSiemBuffer(eventJson: string, error?: string): void {
  db.prepare(`INSERT INTO siem_buffer (id, event_json, last_error, next_attempt) VALUES (?, ?, ?, datetime('now', '+30 seconds'))`).run(randomUUID(), eventJson, error ?? null);
}
export function listPendingSiemBuffer(limit = 50): { id: string; event_json: string; attempts: number }[] {
  return db.prepare(`SELECT id, event_json, attempts FROM siem_buffer WHERE next_attempt IS NULL OR datetime(next_attempt) <= datetime('now') ORDER BY created_at ASC LIMIT ?`).all(limit) as { id: string; event_json: string; attempts: number }[];
}
export function markSiemBufferResult(id: string, ok: boolean, error?: string, backoffSec = 60): void {
  if (ok) db.prepare(`DELETE FROM siem_buffer WHERE id = ?`).run(id);
  else db.prepare(`UPDATE siem_buffer SET attempts = attempts + 1, last_error = ?, next_attempt = datetime('now', '+' || ? || ' seconds') WHERE id = ?`).run(error ?? null, backoffSec, id);
}

// ---------------------------------------------------------------------
// Entra ID config
// ---------------------------------------------------------------------
export type EntraConfig = {
  tenant_id: string | null;
  client_id: string | null;
  client_secret: string | null;
  redirect_uri: string | null;
  issuer: string | null;
  saml_metadata_url: string | null;
  enabled: number;
};
export function getEntraConfig(): EntraConfig {
  return db.prepare(`SELECT * FROM entra_config WHERE id = 1`).get() as EntraConfig;
}
export function updateEntraConfig(c: Partial<EntraConfig>): EntraConfig {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(c)) { sets.push(`${k} = ?`); vals.push(v); }
  if (sets.length) { sets.push("updated_at = datetime('now')"); db.prepare(`UPDATE entra_config SET ${sets.join(", ")} WHERE id = 1`).run(...vals); }
  return getEntraConfig();
}

// ---------------------------------------------------------------------
// Brand config
// ---------------------------------------------------------------------
export type BrandConfig = {
  company_name: string;
  tagline: string;
  logo_url: string;
  logo_dark_url: string | null;
  icon_url: string;
  favicon_url: string;
  primary_color: string;
  secondary_color: string;
  font_family: string;
  email_header_text: string;
  default_theme: string;
  allow_theme_override: number;
};
export function getBrandConfig(): BrandConfig {
  return db.prepare(`SELECT * FROM brand_config WHERE id = 1`).get() as BrandConfig;
}
export function updateBrandConfig(c: Partial<BrandConfig>, updatedBy?: string): BrandConfig {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(c)) { sets.push(`${k} = ?`); vals.push(v); }
  sets.push("updated_by = ?");
  vals.push(updatedBy ?? null);
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE brand_config SET ${sets.join(", ")} WHERE id = 1`).run(...vals);
  return getBrandConfig();
}

// ---------------------------------------------------------------------
// IP rules
// ---------------------------------------------------------------------
export type IpRule = { id: string; type: "allow" | "deny" | "geo_block"; value: string; reason: string | null; created_by: string | null; created_at: string };
export function listIpRules(): IpRule[] {
  return db.prepare(`SELECT * FROM ip_rules ORDER BY created_at DESC`).all() as IpRule[];
}
export function addIpRule(type: IpRule["type"], value: string, reason?: string | null, createdBy?: string | null): IpRule {
  const id = randomUUID();
  db.prepare(`INSERT INTO ip_rules (id, type, value, reason, created_by) VALUES (?, ?, ?, ?, ?)`).run(id, type, value.trim(), reason ?? null, createdBy ?? null);
  return db.prepare(`SELECT * FROM ip_rules WHERE id = ?`).get(id) as IpRule;
}
export function deleteIpRule(id: string): void {
  db.prepare(`DELETE FROM ip_rules WHERE id = ?`).run(id);
}

// ---------------------------------------------------------------------
// Backups registry
// ---------------------------------------------------------------------
export type BackupRecord = { id: string; filename: string; size_bytes: number; encrypted: number; checksum: string | null; created_by: string | null; created_at: string };
export function listBackups(): BackupRecord[] {
  return db.prepare(`SELECT * FROM backups ORDER BY created_at DESC`).all() as BackupRecord[];
}
export function registerBackup(filename: string, sizeBytes: number, encrypted: boolean, checksum?: string | null, createdBy?: string | null): BackupRecord {
  const id = randomUUID();
  db.prepare(`INSERT INTO backups (id, filename, size_bytes, encrypted, checksum, created_by) VALUES (?, ?, ?, ?, ?, ?)`).run(id, filename, sizeBytes, encrypted ? 1 : 0, checksum ?? null, createdBy ?? null);
  return db.prepare(`SELECT * FROM backups WHERE id = ?`).get(id) as BackupRecord;
}
export function deleteBackupRecord(id: string): void {
  db.prepare(`DELETE FROM backups WHERE id = ?`).run(id);
}

// ---------------------------------------------------------------------
// Quarantine accounts still using credentials from the former public demo seed.
// These values are a deny-list, never credentials assigned to an account. Check only
// once per database, before accepting requests; no user data or hashes are deleted.
export async function quarantineLegacyCredentials(): Promise<number> {
  if (db.prepare("SELECT 1 FROM security_migrations WHERE name = ?").get("legacy-demo-passwords-v1")) return 0;
  const users = db.prepare("SELECT id, password_hash FROM users WHERE password_hash IS NOT NULL").all() as { id: string; password_hash: string }[];
  const compromised: string[] = [];
  for (const user of users) {
    for (const oldPassword of COMPROMISED_LEGACY_PASSWORDS) {
      if (await verifyPassword(user.password_hash, oldPassword)) { compromised.push(user.id); break; }
    }
  }
  db.transaction(() => {
    for (const id of compromised) db.prepare("UPDATE users SET status = 'disabled', session_version = session_version + 1 WHERE id = ?").run(id);
    db.prepare("INSERT OR IGNORE INTO security_migrations (name) VALUES (?)").run("legacy-demo-passwords-v1");
  })();
  return compromised.length;
}

export function bootstrapFirstAdmin(email: string, passwordHash: string): string {
  return db.transaction(() => {
    const { count } = db.prepare("SELECT count(*) AS count FROM users").get() as { count: number };
    if (count !== 0) throw new Error("Bootstrap refused: the database already contains users.");
    const tenantId = ensureDefaultTenant();
    return createUser({ tenantId, email, displayName: "Initial administrator", role: "super_admin", passwordHash, status: "active", mfaRequired: true, mustChangePassword: true });
  }).immediate();
}
runMigrations();
