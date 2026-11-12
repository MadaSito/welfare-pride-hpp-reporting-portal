import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import Database from "better-sqlite3";
import { decodeJwt, SignJWT } from "jose";
import { Secret, TOTP } from "otpauth";

let dir: string, db: Database.Database, server: Server, origin: string;
let security: typeof import("./security");
let limiter: typeof import("./mfa-limiter");
const sessionSecret = "mfa-limiter-isolated-test-session-secret";
const base32 = "JBSWY3DPEHPK3PXP";
const csrf = "mfa-test-csrf";
const recovery = "TEST-RECOVERY-ONLY";
const envKeys = ["DATA_DIR", "SQLITE_PATH", "APP_ORIGIN", "APP_SESSION_SECRET", "NODE_ENV"] as const;
const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "mfa-limiter-test-"));
  process.env.DATA_DIR = dir;
  process.env.SQLITE_PATH = path.join(dir, "test.sqlite");
  process.env.APP_SESSION_SECRET = sessionSecret;
  process.env.NODE_ENV = "test";
  const repo = await import("./repository");
  security = await import("./security");
  limiter = await import("./mfa-limiter");
  db = repo.db;
  // Model an existing installation before the new migration.
  db.exec("DROP TABLE IF EXISTS mfa_attempt_limits");
  const { app } = await import("./index");
  server = await new Promise<Server>(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.APP_ORIGIN = origin;
});

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (db) db.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  for (const key of envKeys) { const value = oldEnv[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

beforeEach(() => {
  db.exec("DELETE FROM mfa_attempt_limits; DELETE FROM audit_events; DELETE FROM users;");
  const insert = db.prepare(`INSERT INTO users(id,email,display_name,role,status,auth_provider,mfa_secret_encrypted,mfa_enrolled_at,mfa_recovery_codes)
    VALUES (?,?,'Test User','manager','active','local',?,datetime('now'),?)`);
  insert.run("one", "one@example.test", security.encryptSecret(base32), JSON.stringify([security.hashRecoveryCode(recovery)]));
  insert.run("two", "two@example.test", security.encryptSecret(base32), JSON.stringify([security.hashRecoveryCode(recovery)]));
});

type Stage = "mfa_verify" | "mfa_enroll" | "full" | "password_change";
async function session(user = "one", stage: Stage = "mfa_verify") {
  const base = await security.createSession({ sub: user, role: "manager", tenantId: null, csrf, stage, sessionVersion: 0 }, "30m");
  const token = await new SignJWT({ ...decodeJwt(base), authProvider: "local", status: "active" })
    .setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(sessionSecret));
  return `wp_session=${token}`;
}
let requestNumber = 0;
function verify(cookie: string | undefined, body: object, extra: Record<string, string> = {}) {
  const n = ++requestNumber;
  return fetch(`${origin}/api/v1/auth/mfa/verify`, { method: "POST", headers: {
    "content-type": "application/json", origin, "x-csrf-token": csrf,
    "cf-connecting-ip": `192.0.${Math.floor(n / 250) % 250}.${n % 250 + 1}`,
    "x-forwarded-for": `198.51.${Math.floor(n / 250) % 250}.${n % 250 + 1}`,
    ...(cookie ? { cookie } : {}), ...extra,
  }, body: JSON.stringify(body) });
}
function validOtp() { return new TOTP({ secret: Secret.fromBase32(base32), digits: 6, period: 30 }).generate(); }
function bucket(user = "one") { return db.prepare("SELECT failures, expires_at FROM mfa_attempt_limits WHERE user_id=?").get(user) as { failures: number; expires_at: number } | undefined; }
async function fail(cookie: string, body: object = { code: "invalid-otp-marker" }) {
  const response = await verify(cookie, body);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "INVALID_MFA_CODE" });
  expect(response.headers.getSetCookie()).toEqual([]);
}

describe("persistent account MFA limiter", () => {
  it("migrates existing databases idempotently", () => {
    limiter.migrateMfaLimiter(db);
    limiter.migrateMfaLimiter(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mfa_attempt_limits'").get()).toBeTruthy();
  });

  it("blocks spoofed IPs and correct OTP or recovery after eight failures without replacing the session or exposing codes", async () => {
    const cookie = await session();
    const output = vi.spyOn(process.stdout, "write");
    try {
      const firstAt = Date.now();
      await fail(cookie);
      const expires = bucket()!.expires_at;
      expect(expires).toBeGreaterThanOrEqual(firstAt + limiter.MFA_WINDOW_MS);
      expect(expires).toBeLessThanOrEqual(Date.now() + limiter.MFA_WINDOW_MS);
      for (let i = 1; i < 25; i++) await fail(cookie, i % 2 ? { recoveryCode: "invalid-recovery-marker" } : { code: "invalid-otp-marker" });
      await fail(cookie, { code: validOtp() });
      await fail(cookie, { recoveryCode: recovery });
      expect(bucket()?.failures).toBe(8);
      expect(bucket()?.expires_at).toBe(expires);
      expect(JSON.parse((db.prepare("SELECT mfa_recovery_codes FROM users WHERE id='one'").get() as any).mfa_recovery_codes)).toEqual([security.hashRecoveryCode(recovery)]);
      const audits = db.prepare("SELECT * FROM audit_events WHERE action LIKE 'auth.mfa.%'").all() as any[];
      expect(audits.filter(a => a.action === "auth.mfa.failed")).toHaveLength(8);
      expect(audits.filter(a => a.action === "auth.mfa.blocked")).toHaveLength(19);
      const text = JSON.stringify(audits) + JSON.stringify(output.mock.calls);
      expect(text).not.toContain("invalid-otp-marker");
      expect(text).not.toContain("invalid-recovery-marker");
      expect(text).not.toContain(recovery);
    } finally { output.mockRestore(); }
  });

  it("uses one bucket across enrollment and login, isolated from other accounts", async () => {
    const verifySession = await session();
    for (let i = 0; i < 5; i++) await fail(verifySession);
    db.prepare("UPDATE users SET mfa_enrolled_at=NULL WHERE id='one'").run();
    const enrollment = await session("one", "mfa_enroll");
    for (let i = 0; i < 3; i++) await fail(enrollment);
    await fail(enrollment, { code: validOtp() });
    expect(bucket()?.failures).toBe(8);
    const other = await verify(await session("two"), { code: validOtp() });
    expect(other.status).toBe(200);
    expect(bucket("two")).toBeUndefined();
  });

  it("does not count invalid stages, missing or stale sessions, or unconfigured MFA", async () => {
    const full = await session("one", "full");
    expect((await verify(full, { code: "bad" })).status).toBe(401);
    expect((await verify(undefined, { code: "bad" })).status).toBe(401);
    expect((await verify(await session("one", "mfa_enroll"), { code: "bad" })).status).toBe(409);
    const stale = await session();
    db.prepare("UPDATE users SET session_version=1 WHERE id='one'").run();
    expect((await verify(stale, { code: "bad" })).status).toBe(401);
    db.prepare("UPDATE users SET session_version=0, mfa_secret_encrypted=NULL WHERE id='one'").run();
    expect((await verify(await session(), { code: "bad" })).status).toBe(400);
    expect(bucket()).toBeUndefined();
  });

  it("resets only on confirmed success and accepts a correct code after the window expires", async () => {
    const cookie = await session();
    for (let i = 0; i < 7; i++) await fail(cookie);
    const ok = await verify(cookie, { code: validOtp() });
    expect(ok.status).toBe(200);
    expect(bucket()).toBeUndefined();
    for (let i = 0; i < 8; i++) await fail(cookie, { recoveryCode: "wrong-recovery" });
    await fail(cookie, { code: validOtp() });
    db.prepare("UPDATE mfa_attempt_limits SET expires_at=? WHERE user_id='one'").run(Date.now() - 1);
    const otpAfterWindow = await verify(cookie, { code: validOtp() });
    expect(otpAfterWindow.status).toBe(200);
    expect(bucket()).toBeUndefined();
    for (let i = 0; i < 3; i++) await fail(cookie, { recoveryCode: "wrong-recovery" });
    const afterWindow = await verify(cookie, { recoveryCode: recovery });
    expect(afterWindow.status).toBe(200);
    expect(bucket()).toBeUndefined();
    expect(JSON.parse((db.prepare("SELECT mfa_recovery_codes FROM users WHERE id='one'").get() as any).mfa_recovery_codes)).toEqual([]);
    await fail(cookie, { recoveryCode: recovery });
    expect(bucket()?.failures).toBe(1);
  });

  it("refuses to issue a session if account permissions change while the session is being signed", async () => {
    const cookie = await session();
    const original = SignJWT.prototype.sign;
    let changed = false;
    const spy = vi.spyOn(SignJWT.prototype, "sign").mockImplementation(async function (this: SignJWT, ...args) {
      if (!changed) {
        changed = true;
        db.prepare("UPDATE users SET role='admin', session_version=session_version+1 WHERE id='one'").run();
      }
      return original.apply(this, args);
    });
    try {
      const response = await verify(cookie, { code: validOtp() });
      expect(changed).toBe(true);
      expect(response.status).toBe(401);
      expect(response.headers.getSetCookie()).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it("persists across independent connections and new processes, with serialized checks", async () => {
    const execFileAsync = promisify(execFile);
    const modulePath = path.resolve(process.cwd(), "server/mfa-limiter.ts");
    const script = `
      import Database from 'better-sqlite3';
      import { attemptMfa, migrateMfaLimiter } from ${JSON.stringify(modulePath)};
      const db = new Database(process.argv[1], { timeout: 10000 });
      db.pragma('foreign_keys=ON'); migrateMfaLimiter(db);
      let admitted = 0;
      for (let i = 0; i < 10; i++) {
        const r = attemptMfa(db, 'one', () => {
          admitted++; const until = Date.now() + 15; while (Date.now() < until) {}
          return { status: 'failure' };
        });
      }
      console.log(admitted); db.close();`;
    const children = await Promise.all(Array.from({ length: 4 }, () => execFileAsync(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, process.env.SQLITE_PATH!], { cwd: process.cwd(), timeout: 30000 })));
    expect(children.reduce((sum, child) => sum + Number(child.stdout.trim()), 0)).toBe(8);
    expect(bucket()?.failures).toBe(8);
    await fail(await session(), { code: validOtp() });
    const connection = new Database(process.env.SQLITE_PATH!);
    try { expect((connection.prepare("SELECT failures FROM mfa_attempt_limits WHERE user_id='one'").get() as any).failures).toBe(8); }
    finally { connection.close(); }
  });

  it("never writes untrusted credential-bearing MFA audit headers", async () => {
    const marker = "private-mfa-header-marker";
    const output = vi.spyOn(process.stdout, "write");
    const errors = vi.spyOn(process.stderr, "write");
    try {
      const response = await verify(await session(), { code: marker }, { "x-request-id": marker, "user-agent": marker, "cf-connecting-ip": marker, "cf-ipcountry": marker });
      expect(response.status).toBe(401);
      expect(JSON.stringify(db.prepare("SELECT * FROM audit_events WHERE action='auth.mfa.failed'").all())).not.toContain(marker);
      expect(JSON.stringify(output.mock.calls)).not.toContain(marker);
      const malformed = await fetch(`${origin}/api/v1/auth/mfa/verify`, {
        method: "POST", headers: { "content-type": "application/json" }, body: `{"code":"${marker}`,
      });
      expect(malformed.status).toBe(400);
      expect(JSON.stringify(errors.mock.calls)).not.toContain(marker);
      expect(bucket()?.failures).toBe(1);
    } finally { output.mockRestore(); errors.mockRestore(); }
  });
});
