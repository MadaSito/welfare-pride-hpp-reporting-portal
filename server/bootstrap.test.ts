import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import Database from "better-sqlite3";
import { TOTP, Secret } from "otpauth";
import { SignJWT } from "jose";
import { hashPassword } from "./security";

const tempDirs: string[] = [];
const processes: ChildProcess[] = [];
const secret = "integration-only-session-secret-0123456789";
function tempDir() { const dir = mkdtempSync(path.join(os.tmpdir(), "portal-auth-test-")); tempDirs.push(dir); return dir; }
function cli(dataDir: string) {
  // script provides the required pseudo-terminal; output remains in memory only.
  return spawnSync("script", ["-q", "-e", "-c", "node --import tsx server/bootstrap-admin.ts --email first@example.org", "/dev/null"], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, DATA_DIR: dataDir, SQLITE_PATH: "", NODE_ENV: "production" },
  });
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function start(dataDir: string) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn("node", ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(), stdio: "ignore", env: { ...process.env, DATA_DIR: dataDir, SQLITE_PATH: "", NODE_ENV: "production", PORT: String(port), BIND_ADDRESS: "127.0.0.1", APP_ORIGIN: origin,
      APP_SESSION_SECRET: secret, APP_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString("base64"), COOKIE_INSECURE: "true", SESSION_COOKIE_NAME: "wp_session",
      EVAL_MFA: "optional", PREVIEW_MODE: "true", AUTH_RATELIMIT_MAX: "100" },
  });
  processes.push(child);
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("Test server exited unexpectedly");
    try { if ((await fetch(`${origin}/api/v1/health`)).ok) return origin; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Test server did not start");
}
afterEach(async () => {
  for (const p of processes.splice(0)) {
    if (p.exitCode === null) { p.kill("SIGTERM"); await new Promise<void>(resolve => p.once("exit", () => resolve())); }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("secure bootstrap and first sign-in", () => {
  it("allows only MFA-verified password rotation and rejects stale sessions", async () => {
    const dir = tempDir();
    const nonTerminal = spawnSync("node", ["--import", "tsx", "server/bootstrap-admin.ts", "--email", "first@example.org"], { cwd: process.cwd(), env: { ...process.env, DATA_DIR: dir, SQLITE_PATH: "" }, encoding: "utf8" });
    expect(nonTerminal.status).not.toBe(0);
    const first = cli(dir);
    expect(first.status).toBe(0);
    const password = first.stdout.match(/Temporary password \(shown once\): (\S+)/)?.[1];
    expect(password).toBeTruthy();
    expect(cli(dir).status).not.toBe(0);
    const database = new Database(path.join(dir, "portal.db"));
    const user = database.prepare("SELECT id, password_hash, must_change_password, mfa_required, session_version FROM users").get() as any;
    expect(user.must_change_password).toBe(1);
    expect(user.mfa_required).toBe(1);
    expect(user.password_hash).not.toContain(password);
    expect((database.prepare("SELECT count(*) AS n FROM monthly_metrics").get() as any).n).toBe(0);
    expect((database.prepare("SELECT count(*) AS n FROM reports").get() as any).n).toBe(0);
    database.close();
    const origin = await start(dir);
    const forgedOldFull = await new SignJWT({ role: "super_admin", tenantId: null, stage: "full", csrf: "old", sessionVersion: user.session_version })
      .setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setIssuer("welfare-pride-hpp").setAudience("welfare-pride-hpp-web").setExpirationTime("10m").sign(new TextEncoder().encode(secret));
    const request = async (url: string, options: { method?: string; body?: object; cookie?: string; csrf?: string; origin?: string } = {}) => {
      const headers: Record<string, string> = { origin: options.origin || origin };
      if (options.body) headers["content-type"] = "application/json";
      if (options.cookie) headers.cookie = options.cookie;
      if (options.csrf) headers["x-csrf-token"] = options.csrf;
      const res = await fetch(origin + url, { method: options.method || "GET", headers, body: options.body ? JSON.stringify(options.body) : undefined });
      return { status: res.status, body: await res.json(), cookie: res.headers.get("set-cookie")?.split(";")[0] || "" };
    };
    expect((await request("/api/v1/metrics", { cookie: `wp_session=${forgedOldFull}` })).status).toBe(401);
    expect((await request("/api/v1/auth/login", { method: "POST", body: { email: "first@example.org", password }, origin: "https://evil.us5.manus.computer" })).status).toBe(403);
    expect((await request("/api/v1/auth/forgot", { method: "POST", body: { email: "first@example.org" } })).status).toBe(501);
    const login = await request("/api/v1/auth/login", { method: "POST", body: { email: "first@example.org", password } });
    expect(login.body.stage).toBe("mfa_enroll");
    expect((await request("/api/v1/metrics", { cookie: login.cookie })).status).toBe(401);
    expect((await request("/api/v1/auth/password", { method: "POST", cookie: login.cookie, csrf: login.body.csrf, body: { currentPassword: password, newPassword: "Valid-New-Password#83!" } })).status).toBe(401);
    expect((await request("/api/v1/auth/mfa/enroll", { method: "POST", cookie: login.cookie })).status).toBe(403);
    const enroll = await request("/api/v1/auth/mfa/enroll", { method: "POST", cookie: login.cookie, csrf: login.body.csrf });
    expect(enroll.status).toBe(200);
    const token = new TOTP({ secret: Secret.fromBase32(enroll.body.manualSecret), digits: 6, period: 30 }).generate();
    const verified = await request("/api/v1/auth/mfa/verify", { method: "POST", cookie: login.cookie, csrf: login.body.csrf, body: { code: token } });
    expect(verified.body.stage).toBe("password_change");
    expect(verified.body.recoveryCodes).toHaveLength(8);
    expect((await request("/api/v1/metrics", { cookie: verified.cookie })).status).toBe(401);
    const same = await request("/api/v1/auth/password", { method: "POST", cookie: verified.cookie, csrf: verified.body.csrf, body: { currentPassword: password, newPassword: password } });
    expect(same.body.error).toBe("PASSWORD_MUST_DIFFER");
    const changed = await request("/api/v1/auth/password", { method: "POST", cookie: verified.cookie, csrf: verified.body.csrf, body: { currentPassword: password, newPassword: "Valid-New-Password#83!" } });
    expect(changed.body.stage).toBe("full");
    expect((await request("/api/v1/metrics", { cookie: changed.cookie })).status).toBe(200);
    expect((await request("/api/v1/metrics", { cookie: `wp_session=${forgedOldFull}` })).status).toBe(401);
    expect((await request("/api/v1/auth/session", { cookie: verified.cookie })).status).toBe(401);
    expect((await request("/api/v1/auth/mfa/enroll", { method: "POST", cookie: changed.cookie, csrf: changed.body.csrf })).status).toBe(401);
    expect((await request("/api/v1/admin/backups", { method: "POST", cookie: changed.cookie, csrf: changed.body.csrf })).status).toBe(501);
    expect((await request("/api/v1/admin/backups/restore", { method: "POST", cookie: changed.cookie, csrf: changed.body.csrf })).status).toBe(501);
    expect((await request(`/api/v1/admin/users/${user.id}/convert-sso`, { method: "POST", cookie: changed.cookie, csrf: changed.body.csrf })).status).toBe(501);
    expect((await request("/api/v1/auth/login", { method: "POST", body: { email: "first@example.org", password } })).status).toBe(401);
    const relogin = await request("/api/v1/auth/login", { method: "POST", body: { email: "first@example.org", password: "Valid-New-Password#83!" } });
    expect(relogin.body.stage).toBe("mfa_verify");
  }, 30000);

  it("migrates legacy databases without deleting data and quarantines exposed demo credentials", async () => {
    const dir = tempDir();
    const db = new Database(path.join(dir, "portal.db"));
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', password_hash TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', sso_id TEXT, mfa_required INTEGER NOT NULL DEFAULT 1, mfa_secret_encrypted TEXT, mfa_enrolled_at TEXT, mfa_recovery_codes TEXT, locked_until TEXT, failed_sign_in_count INTEGER NOT NULL DEFAULT 0, last_signed_in_at TEXT, created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    const vulnerableHash = await hashPassword("SuperAdmin2026!#W");
    const safeHash = await hashPassword("A-unique-Password#64!");
    db.prepare("INSERT INTO users(id,email,display_name,role,password_hash) VALUES(?,?,?,?,?)").run("legacy", "old@example.org", "Preserve legacy", "super_admin", vulnerableHash);
    db.prepare("INSERT INTO users(id,email,display_name,role,password_hash) VALUES(?,?,?,?,?)").run("safe", "safe@example.org", "Preserve safe", "manager", safeHash);
    db.close();
    await start(dir);
    const migrated = new Database(path.join(dir, "portal.db"), { readonly: true });
    const rows = migrated.prepare("SELECT id, display_name, password_hash, status, session_version FROM users ORDER BY id").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "legacy", display_name: "Preserve legacy", password_hash: vulnerableHash, status: "disabled" });
    expect(rows[1]).toMatchObject({ id: "safe", display_name: "Preserve safe", password_hash: safeHash, status: "active", session_version: 1 });
    migrated.close();
  }, 30000);
});

// These fixtures use a private temporary SQLite database and a loopback-only server.
const fixturePassword = "Unique-test-password#83!";
const fixtureMfa = "JBSWY3DPEHPK3PXP";
type AuthResponse = { status: number; body: any; cookie: string; cache: string | null };
type Session = { cookie: string; csrf: string };
async function authFixture() {
  const dir = tempDir();
  const origin = await start(dir);
  const db = new Database(path.join(dir, "portal.db"));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 42), iv);
  const encrypted = [iv, Buffer.concat([cipher.update(fixtureMfa), cipher.final()]), cipher.getAuthTag()].map(b => b.toString("base64url")).join(".");
  const hash = await hashPassword(fixturePassword);
  const insert = db.prepare("INSERT INTO users (id,email,display_name,role,status,password_hash,mfa_secret_encrypted,mfa_enrolled_at) VALUES (?,?,?,?,'active',?,?,datetime('now'))");
  insert.run("admin", "admin@test.example", "Admin", "super_admin", hash, encrypted);
  insert.run("target", "target@test.example", "Target", "manager", hash, encrypted);
  db.close();
  async function request(url: string, opts: { method?: string; body?: object; session?: Session } = {}): Promise<AuthResponse> {
    const headers: Record<string, string> = { origin };
    if (opts.body) headers["content-type"] = "application/json";
    if (opts.session) { headers.cookie = opts.session.cookie; headers["x-csrf-token"] = opts.session.csrf; }
    const res = await fetch(origin + url, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    return { status: res.status, body: await res.json(), cookie: res.headers.get("set-cookie")?.split(";")[0] || "", cache: res.headers.get("cache-control") };
  }
  async function pending(id = "target"): Promise<Session> {
    const r = await request("/api/v1/auth/login", { method: "POST", body: { email: `${id}@test.example`, password: fixturePassword } });
    expect(r.status).toBe(200);
    expect(r.body.stage).toBe("mfa_verify");
    expect(r.cache).toBe("no-store");
    return { cookie: r.cookie, csrf: r.body.csrf };
  }
  async function login(id = "target"): Promise<Session> {
    const p = await pending(id);
    const code = new TOTP({ secret: Secret.fromBase32(fixtureMfa), digits: 6, period: 30 }).generate();
    const r = await request("/api/v1/auth/mfa/verify", { method: "POST", session: p, body: { code } });
    expect(r.status).toBe(200);
    expect(r.body.stage).toBe("full");
    expect(r.cache).toBe("no-store");
    return { cookie: r.cookie, csrf: r.body.csrf };
  }
  async function check(session: Session, expected: number) {
    const r = await request("/api/v1/auth/session", { session });
    expect(r.status).toBe(expected);
    expect(r.cache).toBe("no-store");
  }
  return { dir, request, pending, login, check };
}

describe("session revocation and security-state snapshots", () => {
  it("revokes copied full and pending cookies on logout, without invalidating a new login on replay", async () => {
    const f = await authFixture();
    const full = await f.login();
    const another = await f.login();
    const pending = await f.pending();
    const result = await f.request("/api/v1/auth/logout", { method: "POST", session: full });
    expect(result.status).toBe(200);
    expect(result.cache).toBe("no-store");
    expect(result.cookie).toBe("wp_session=");
    await f.check(full, 401);
    await f.check(another, 401);
    await f.check(pending, 401);
    const fresh = await f.login();
    expect((await f.request("/api/v1/auth/logout", { method: "POST", session: full })).status).toBe(401);
    await f.check(fresh, 200);
    const freshPending = await f.pending();
    expect((await f.request("/api/v1/auth/logout", { method: "POST", session: freshPending })).status).toBe(200);
    await f.check(fresh, 401);
  }, 30000);

  it("revokes demoted users' full and pending sessions even after restoring their role, but preserves no-op updates", async () => {
    const f = await authFixture();
    const admin = await f.login("admin");
    const full = await f.login();
    const pending = await f.pending();
    expect((await f.request("/api/v1/admin/users/admin", { method: "PATCH", session: admin, body: { role: "super_admin", status: "active", displayName: "Still Admin", mfaRequired: true } })).status).toBe(200);
    await f.check(admin, 200);
    expect((await f.request("/api/v1/admin/users/target", { method: "PATCH", session: admin, body: { role: "view_only" } })).status).toBe(200);
    await f.check(full, 401);
    await f.check(pending, 401);
    expect((await f.request("/api/v1/admin/users/target", { method: "PATCH", session: admin, body: { role: "manager" } })).status).toBe(200);
    await f.check(full, 401);
    await f.check(pending, 401);
    await f.check(await f.login(), 200);
  }, 30000);

  it("revokes sessions through disable and re-enable", async () => {
    const f = await authFixture();
    const admin = await f.login("admin");
    const full = await f.login();
    const pending = await f.pending();
    expect((await f.request("/api/v1/admin/users/target", { method: "PATCH", session: admin, body: { status: "disabled" } })).status).toBe(200);
    await f.check(full, 401);
    expect((await f.request("/api/v1/admin/users/target", { method: "PATCH", session: admin, body: { status: "active" } })).status).toBe(200);
    await f.check(full, 401);
    await f.check(pending, 401);
    await f.check(await f.login(), 200);
  }, 30000);

  it("revokes full and pending cookies after MFA reset, including after re-enrollment", async () => {
    const f = await authFixture();
    const admin = await f.login("admin");
    const full = await f.login();
    const pending = await f.pending();
    expect((await f.request("/api/v1/admin/users/target/reset-mfa", { method: "POST", session: admin })).status).toBe(200);
    await f.check(full, 401);
    await f.check(pending, 401);
    const newLogin = await f.request("/api/v1/auth/login", { method: "POST", body: { email: "target@test.example", password: fixturePassword } });
    expect(newLogin.body.stage).toBe("mfa_enroll");
    const staleEnrollment = { cookie: newLogin.cookie, csrf: newLogin.body.csrf };
    // A second reset must revoke even an as-yet-unenrolled pending session.
    expect((await f.request("/api/v1/admin/users/target/reset-mfa", { method: "POST", session: admin })).status).toBe(200);
    expect((await f.request("/api/v1/auth/mfa/enroll", { method: "POST", session: staleEnrollment })).status).toBe(401);
    const nextLogin = await f.request("/api/v1/auth/login", { method: "POST", body: { email: "target@test.example", password: fixturePassword } });
    expect(nextLogin.body.stage).toBe("mfa_enroll");
    const enrollSession = { cookie: nextLogin.cookie, csrf: nextLogin.body.csrf };
    const enrollment = await f.request("/api/v1/auth/mfa/enroll", { method: "POST", session: enrollSession });
    expect(enrollment.status).toBe(200);
    expect(enrollment.cache).toBe("no-store");
    const code = new TOTP({ secret: Secret.fromBase32(enrollment.body.manualSecret), digits: 6, period: 30 }).generate();
    const verified = await f.request("/api/v1/auth/mfa/verify", { method: "POST", session: enrollSession, body: { code } });
    expect(verified.body.stage).toBe("full");
    expect(verified.body.recoveryCodes).toHaveLength(8);
    expect(verified.cache).toBe("no-store");
    await f.check(full, 401);
    await f.check(pending, 401);
    await f.check({ cookie: verified.cookie, csrf: verified.body.csrf }, 200);
  }, 30000);

  it("issues a current full session when completing an invited account's enrollment", async () => {
    const f = await authFixture();
    const db = new Database(path.join(f.dir, "portal.db"));
    db.prepare("UPDATE users SET status = 'invited', mfa_secret_encrypted = NULL, mfa_enrolled_at = NULL WHERE id = 'target'").run();
    db.close();
    const login = await f.request("/api/v1/auth/login", { method: "POST", body: { email: "target@test.example", password: fixturePassword } });
    const pending = { cookie: login.cookie, csrf: login.body.csrf };
    expect(login.body.stage).toBe("mfa_enroll");
    const enrolled = await f.request("/api/v1/auth/mfa/enroll", { method: "POST", session: pending });
    const code = new TOTP({ secret: Secret.fromBase32(enrolled.body.manualSecret), digits: 6, period: 30 }).generate();
    const verified = await f.request("/api/v1/auth/mfa/verify", { method: "POST", session: pending, body: { code } });
    expect(verified.body.stage).toBe("full");
    await f.check(pending, 401);
    await f.check({ cookie: verified.cookie, csrf: verified.body.csrf }, 200);
  }, 30000);

  it("rejects signed tokens with mismatched role, tenant, provider or status, and updates repository security fields atomically", async () => {
    const f = await authFixture();
    const full = await f.login();
    const db = new Database(path.join(f.dir, "portal.db"), { readonly: true });
    const { session_version } = db.prepare("SELECT session_version FROM users WHERE id = 'target'").get() as { session_version: number };
    db.close();
    const claims = { role: "manager", tenantId: null, authProvider: "local", status: "active", stage: "full", csrf: "test", sessionVersion: session_version };
    for (const diff of [{ role: "super_admin" }, { tenantId: "another-tenant" }, { tenantId: undefined }, { authProvider: "sso" }, { status: "invited" }, { authProvider: undefined }]) {
      const token = await new SignJWT({ ...claims, ...diff }).setProtectedHeader({ alg: "HS256" }).setSubject("target")
        .setIssuer("welfare-pride-hpp").setAudience("welfare-pride-hpp-web").setExpirationTime("10m").sign(new TextEncoder().encode(secret));
      await f.check({ cookie: `wp_session=${token}`, csrf: "test" }, 401);
    }
    // Invoke the real repository in a subprocess pointed only at the temporary database.
    const script = `import { db, updateUser, findUserById } from './server/repository.ts';
      db.prepare("INSERT INTO tenants(id,name) VALUES ('tenant-a','Tenant A')").run();
      const version = () => findUserById('target').session_version;
      const versions = [version()];
      for (const fields of [{displayName:'Renamed'}, {role:'manager'}, {tenantId:'tenant-a'}, {tenantId:null}, {authProvider:'sso'}, {authProvider:'local'}, {ssoId:'identity'}, {ssoId:null}, {status:'disabled'}, {status:'active'}]) {
        updateUser('target', fields); versions.push(version());
      }
      console.log(JSON.stringify(versions)); db.close();`;
    const child = spawnSync("node", ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, DATA_DIR: f.dir, SQLITE_PATH: "" } });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toEqual([session_version, session_version, session_version, ...Array.from({ length: 8 }, (_, i) => session_version + i + 1)]);
    await f.check(full, 401);
  }, 30000);
});
