import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:net";
import Database from "better-sqlite3";
import { TOTP, Secret } from "otpauth";

const dirs: string[] = [];
const processes: ChildProcess[] = [];
function fixtureDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wp-install-test-"));
  dirs.push(dir);
  return dir;
}
function env(dataDir: string) {
  return { ...process.env, DATA_DIR: dataDir, SQLITE_PATH: "", NODE_ENV: "production", REQUIRE_LOCAL_MFA: "true",
    APP_SESSION_SECRET: "installation-test-only-session-secret-0123456789", APP_ENCRYPTION_KEY: Buffer.alloc(32, 79).toString("base64"), AUDIT_HASH_SALT: "test-only-independent-salt" };
}
function bootstrap(dir: string) {
  // This creates a test PTY and keeps its disposable credential only in memory;
  // the production installer never invokes script or captures bootstrap output.
  return spawnSync("script", ["-q", "-e", "-c", "node --import tsx server/install-admin.ts --email install@example.org", "/dev/null"], { cwd: process.cwd(), encoding: "utf8", env: env(dir), timeout: 20000 });
}
async function server(dir: string) {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn("node", ["--import", "tsx", "server/index.ts"], { cwd: process.cwd(), stdio: "ignore", env: {
    ...env(dir), APP_ORIGIN: origin, PORT: String(port), BIND_ADDRESS: "127.0.0.1", SESSION_COOKIE_NAME: "wp_session",
    COOKIE_INSECURE: "true", AUTH_RATELIMIT_MAX: "100", PREVIEW_MODE: "true", EVAL_MFA: "optional",
  } });
  processes.push(child);
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("Disposable test server failed to start");
    try { if ((await fetch(`${origin}/api/v1/health`)).ok) return origin; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Disposable test server startup timed out");
}
afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>(resolve => child.once("exit", () => resolve()));
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("new-server installation bootstrap", () => {
  it("refuses captured output before opening a database", () => {
    const dir = path.join(fixtureDir(), "not-created");
    const result = spawnSync("node", ["--import", "tsx", "server/install-admin.ts", "--email", "install@example.org"], { cwd: process.cwd(), encoding: "utf8", env: env(dir) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("PRIVATE_TERMINAL_REQUIRED");
    expect(result.stdout).toBe("");
    expect(existsSync(dir)).toBe(false);
  });

  it("creates one audited admin and gates full access behind MFA and a password change", async () => {
    const dir = fixtureDir();
    const first = bootstrap(dir);
    expect(first.status).toBe(0);
    const password = first.stdout.match(/Temporary password \(shown once\): (\S+)/)?.[1];
    expect(typeof password === "string" && password.length >= 32).toBe(true);
    const db = new Database(path.join(dir, "portal.db"));
    try {
      const user = db.prepare("SELECT * FROM users").get() as any;
      expect(user.mfa_required).toBe(1);
      expect(user.must_change_password).toBe(1);
      expect(user.auth_provider).toBe("local");
      expect(user.role).toBe("super_admin");
      expect(!!user.tenant_id).toBe(true);
      expect(user.password_hash.includes(password)).toBe(false);
      const audit = db.prepare("SELECT * FROM audit_events WHERE action = 'installation.admin.created'").get() as any;
      expect(audit.method).toBe("CLI");
      expect(audit.resource_id).toBe(user.id);
      expect(JSON.stringify(audit).includes(password!)).toBe(false);
      expect(bootstrap(dir).status).not.toBe(0);
      expect((db.prepare("SELECT count(*) AS n FROM users").get() as any).n).toBe(1);
      expect((db.prepare("SELECT password_hash FROM users").get() as any).password_hash).toBe(user.password_hash);
      const origin = await server(dir);
      type Session = { cookie: string; csrf: string };
      async function request(url: string, method = "GET", body?: object, session?: Session) {
        const res = await fetch(origin + url, { method, headers: { origin, ...(body ? { "content-type": "application/json" } : {}), ...(session ? { cookie: session.cookie, "x-csrf-token": session.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json(), cookie: res.headers.get("set-cookie")?.split(";")[0] || "" };
      }
      expect((await request("/api/v1/auth/setup/status")).body.setupNeeded).toBe(false);
      expect((await request("/api/v1/auth/setup", "POST", { email: "attacker@example.org", password: "Unused-Password#65!" })).status).toBe(409);
      const login = await request("/api/v1/auth/login", "POST", { email: "install@example.org", password });
      expect(login.body.stage).toBe("mfa_enroll");
      const pending = { cookie: login.cookie, csrf: login.body.csrf };
      expect((await request("/api/v1/metrics", "GET", undefined, pending)).status).toBe(401);
      const enrolled = await request("/api/v1/auth/mfa/enroll", "POST", {}, pending);
      expect(enrolled.status).toBe(200);
      const code = new TOTP({ secret: Secret.fromBase32(enrolled.body.manualSecret), digits: 6, period: 30 }).generate();
      const verified = await request("/api/v1/auth/mfa/verify", "POST", { code }, pending);
      expect(verified.body.stage).toBe("password_change");
      expect(verified.body.recoveryCodes).toHaveLength(8);
      const restricted = { cookie: verified.cookie, csrf: verified.body.csrf };
      expect((await request("/api/v1/metrics", "GET", undefined, restricted)).status).toBe(401);
      expect((await request("/api/v1/auth/password", "POST", { currentPassword: password, newPassword: "too-short" }, restricted)).status).toBe(400);
      const changed = await request("/api/v1/auth/password", "POST", { currentPassword: password, newPassword: "New-installation-password#87!" }, restricted);
      expect(changed.body.stage).toBe("full");
      const full = { cookie: changed.cookie, csrf: changed.body.csrf };
      expect((await request("/api/v1/metrics", "GET", undefined, full)).status).toBe(200);
      expect((await request("/api/v1/auth/session", "GET", undefined, restricted)).status).toBe(401);
      const disabled = await request(`/api/v1/admin/users/${user.id}`, "PATCH", { mfaRequired: false }, full);
      expect(disabled.status).toBe(400);
      expect(disabled.body.error).toBe("LOCAL_MFA_REQUIRED");
      const created = await request("/api/v1/admin/users", "POST", { email: "next@example.org", displayName: "Next admin", role: "manager" }, full);
      expect(created.status).toBe(201);
      const next = db.prepare("SELECT mfa_required, must_change_password FROM users WHERE email = 'next@example.org'").get() as any;
      expect(next.mfa_required).toBe(1);
      expect(next.must_change_password).toBe(1);
      const rejected = await request("/api/v1/admin/users", "POST", { email: "optional@example.org", displayName: "Not allowed", role: "manager", mfaRequired: false }, full);
      expect(rejected.body.error).toBe("LOCAL_MFA_REQUIRED");
      const again = await request("/api/v1/auth/login", "POST", { email: "install@example.org", password: "New-installation-password#87!" });
      expect(again.body.stage).toBe("mfa_verify");
    } finally { db.close(); }
  }, 40000);

  it("rolls back admin creation if the audit insert fails", () => {
    const dir = fixtureDir();
    const init = spawnSync("node", ["--import", "tsx", "--input-type=module", "-e", "import { db } from './server/repository.ts'; db.exec(\"CREATE TRIGGER fail_install_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END\"); db.close();"], { cwd: process.cwd(), env: env(dir), encoding: "utf8" });
    expect(init.status).toBe(0);
    const result = bootstrap(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout.includes("Temporary password (shown once):")).toBe(false);
    const db = new Database(path.join(dir, "portal.db"));
    try { expect((db.prepare("SELECT count(*) AS n FROM users").get() as any).n).toBe(0); } finally { db.close(); }
  }, 30000);
});
