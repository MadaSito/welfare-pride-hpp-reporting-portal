import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";
import type Database from "better-sqlite3";
import { TOTP, Secret } from "otpauth";

const mocks = vi.hoisted(() => ({ sendMail: vi.fn(), createTransport: vi.fn() }));
vi.mock("nodemailer", () => ({ default: { createTransport: mocks.createTransport } }));
let dir: string, db: Database.Database, server: Server, origin: string;
const envKeys = ["DATA_DIR", "SQLITE_PATH", "APP_ORIGIN", "APP_SESSION_SECRET", "EMAIL_SIMULATED", "GLOBAL_EMAIL_BCC", "NODE_ENV"] as const;
const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const secret = "JBSWY3DPEHPK3PXP";
let encryptSecret: (text: string) => string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "magic-login-test-"));
  process.env.DATA_DIR = dir;
  process.env.SQLITE_PATH = path.join(dir, "test.sqlite");
  process.env.APP_SESSION_SECRET = "magic-test-session-secret-not-for-production";
  process.env.NODE_ENV = "test";
  process.env.EMAIL_SIMULATED = "false";
  process.env.GLOBAL_EMAIL_BCC = "";
  const repo = await import("./repository");
  ({ encryptSecret } = await import("./security"));
  db = repo.db; repo.runMigrations();
  db.exec("INSERT INTO tenants(id,name) VALUES ('a','Tenant A'),('b','Tenant B')");
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
  db.exec("DELETE FROM magic_links; DELETE FROM magic_link_limits; DELETE FROM mail_logs; DELETE FROM audit_events; DELETE FROM users;");
  db.prepare(`INSERT INTO users(id,tenant_id,email,display_name,role,status,auth_provider,password_hash,mfa_required,mfa_enrolled_at,mfa_secret_encrypted)
    VALUES ('u','a','user@example.test','User','manager','active','local','password-hash',1,datetime('now'),?)`).run(encryptSecret(secret));
  db.exec("UPDATE email_config SET enabled=1,primary_provider='smtp',secondary_provider='graph',smtp_host='smtp.example.test',smtp_secure=0,global_bcc=NULL");
  process.env.EMAIL_SIMULATED = "false"; process.env.GLOBAL_EMAIL_BCC = ""; process.env.APP_ORIGIN = origin;
  mocks.sendMail.mockReset().mockResolvedValue({});
  mocks.createTransport.mockReset().mockReturnValue({ sendMail: mocks.sendMail });
});

function post(route: string, body: object, cookie?: string, extra: Record<string, string> = {}) {
  return fetch(origin + `/api/v1/auth/magic-link/${route}`, { method: "POST", headers: {
    "content-type": "application/json", origin, ...(cookie ? { cookie } : {}), ...extra,
  }, body: JSON.stringify(body) });
}
function cookie(response: Response, name: string) {
  const values = response.headers.getSetCookie();
  const value = values.find(v => v.startsWith(name + "="));
  expect(value).toBeDefined();
  return value!.split(";")[0];
}
async function requestLink(email = "user@example.test", existingBinding?: string) {
  const count = mocks.sendMail.mock.calls.length;
  const response = await post("request", { email }, existingBinding);
  expect(response.status).toBe(202); expect(await response.json()).toEqual({ ok: true });
  const binding = cookie(response, "wp_magic_browser");
  await vi.waitFor(() => expect(mocks.sendMail).toHaveBeenCalledTimes(count + 1));
  const mail = mocks.sendMail.mock.calls[count][0];
  const link = mail.text.match(/https?:\/\/[^\s]+/)[0] as string;
  const parsed = new URL(link);
  const token = new URLSearchParams(parsed.hash.slice(1)).get("token")!;
  return { binding, token, mail, response, parsed };
}

describe("magic-link login", () => {
  it("audits generic requests and consumption without credentials, addresses, or untrusted headers", async () => {
    const output = vi.spyOn(process.stdout, "write");
    try {
      const email = "user@example.test";
      const request = await post("request", { email }, undefined, { "x-request-id": email, "user-agent": email, "cf-ipcountry": email });
      expect(request.status).toBe(202);
      const binding = cookie(request, "wp_magic_browser");
      await vi.waitFor(() => expect(mocks.sendMail).toHaveBeenCalledTimes(1));
      const link = mocks.sendMail.mock.calls[0][0].text.match(/https?:\/\/[^\s]+/)[0] as string;
      const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token")!;
      const exchange = await post("consume", { token }, binding, { "x-request-id": token, "user-agent": token, "cf-ipcountry": token });
      expect(exchange.status).toBe(200);
      const session = cookie(exchange, "wp_session");
      const body = await exchange.json();
      expect(body.stage).toBe("mfa_verify");
      expect((await post("consume", { token }, binding)).status).toBe(401);
      await vi.waitFor(() => expect(db.prepare("SELECT * FROM audit_events WHERE action LIKE 'auth.magic_link.%'").all()).toHaveLength(3));
      const events = db.prepare("SELECT * FROM audit_events WHERE action LIKE 'auth.magic_link.%'").all() as any[];
      const requested = events.find(e => e.action === "auth.magic_link.requested");
      const succeeded = events.find(e => e.action === "auth.magic_link.consume_succeeded");
      const failed = events.find(e => e.action === "auth.magic_link.consume_failed");
      expect(requested).toMatchObject({ actor_id: null, resource_id: null, tenant_id: null, actor_email: null, status_code: 202 });
      expect(succeeded).toMatchObject({ actor_id: "u", resource_id: "u", tenant_id: "a", actor_role: "manager", actor_email: null, status_code: 200 });
      expect(failed).toMatchObject({ actor_id: null, resource_id: null, actor_email: null, status_code: 401 });
      const savedAndLogged = JSON.stringify(events) + JSON.stringify(output.mock.calls);
      for (const forbidden of [email, token, link, binding, binding.split("=")[1], session, session.split("=")[1], body.csrf, "#token="]) {
        expect(savedAndLogged).not.toContain(forbidden);
      }
    } finally { output.mockRestore(); }
  });

  it("audits known, unknown, invalid and throttled requests identically without account identity", async () => {
    const addresses = ["user@example.test", "missing@example.test", "not-an-email", "missing@example.test", "missing@example.test", "missing@example.test"];
    for (const email of addresses) {
      const response = await post("request", { email });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ ok: true });
      expect(cookie(response, "wp_magic_browser")).toMatch(/^wp_magic_browser=/);
    }
    await vi.waitFor(() => expect(db.prepare("SELECT * FROM audit_events WHERE action='auth.magic_link.requested'").all()).toHaveLength(addresses.length));
    const rows = db.prepare("SELECT action,severity,resource_type,resource_id,actor_id,actor_role,actor_email,tenant_id,status_code,metadata FROM audit_events WHERE action='auth.magic_link.requested'").all() as any[];
    expect(rows.every(row => JSON.stringify(row) === JSON.stringify(rows[0]))).toBe(true);
    expect(rows[0]).toMatchObject({ actor_id: null, resource_id: null, actor_email: null, tenant_id: null, status_code: 202 });
    expect(JSON.stringify(rows)).not.toContain("example.test");
  });

  it("audits malformed and origin-rejected exchanges without copying their input", async () => {
    const marker = "private-invalid-token-marker";
    const malformed = await fetch(origin + "/api/v1/auth/magic-link/consume", { method: "POST", headers: {
      "content-type": "application/json", origin,
    }, body: `{"token":"${marker}` });
    expect(malformed.status).toBe(400);
    expect((await post("consume", { token: marker }, undefined, { origin: "https://evil.example" })).status).toBe(403);
    await vi.waitFor(() => expect(db.prepare("SELECT * FROM audit_events WHERE action='auth.magic_link.consume_failed'").all()).toHaveLength(2));
    const rows = db.prepare("SELECT * FROM audit_events WHERE action='auth.magic_link.consume_failed'").all() as any[];
    expect(rows.map(row => row.status_code).sort()).toEqual([400, 403]);
    expect(JSON.stringify(rows)).not.toContain(marker);
  });

  it("audits firewall-blocked requests and exchanges without their input", async () => {
    db.exec("INSERT INTO ip_rules(id,type,value) VALUES ('magic-test-deny','deny','127.0.0.1')");
    try {
      expect((await post("request", { email: "blocked@example.test" })).status).toBe(403);
      expect((await post("consume", { token: "blocked-token-marker" })).status).toBe(403);
      await vi.waitFor(() => expect(db.prepare("SELECT * FROM audit_events WHERE action LIKE 'auth.magic_link.%'").all()).toHaveLength(2));
      const rows = db.prepare("SELECT action,status_code,actor_id,actor_email,resource_id FROM audit_events WHERE action LIKE 'auth.magic_link.%' ORDER BY action").all();
      expect(rows).toEqual([
        { action: "auth.magic_link.consume_failed", status_code: 403, actor_id: null, actor_email: null, resource_id: null },
        { action: "auth.magic_link.requested", status_code: 403, actor_id: null, actor_email: null, resource_id: null },
      ]);
      expect(JSON.stringify(db.prepare("SELECT * FROM audit_events").all())).not.toMatch(/blocked@example\.test|blocked-token-marker/);
    } finally { db.exec("DELETE FROM ip_rules WHERE id='magic-test-deny'"); }
  });

  it("keeps requests generic and never attaches a session when audit storage fails", async () => {
    const { binding, token } = await requestLink();
    db.exec("CREATE TEMP TRIGGER fail_magic_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(FAIL, 'audit storage failure'); END");
    const output = vi.spyOn(process.stdout, "write");
    try {
      const request = await post("request", { email: "missing@example.test" });
      expect(request.status).toBe(202);
      expect(await request.json()).toEqual({ ok: true });
      const exchange = await post("consume", { token }, binding);
      expect(exchange.status).toBe(401);
      expect(await exchange.json()).toEqual({ error: "INVALID_MAGIC_LINK" });
      expect(exchange.headers.getSetCookie().some(value => value.startsWith("wp_session="))).toBe(false);
      await new Promise(resolve => setImmediate(resolve));
      const logged = JSON.stringify(output.mock.calls);
      for (const forbidden of [token, binding, "missing@example.test", "audit storage failure"]) expect(logged).not.toContain(forbidden);
    } finally {
      output.mockRestore();
      db.exec("DROP TRIGGER IF EXISTS fail_magic_audit");
    }
  });

  it("emails only the account, uses a fragment and SHA-256 storage, and never grants full access before MFA", async () => {
    const { binding, token, mail, parsed, response } = await requestLink("USER@example.test");
    expect(mail.to).toBe("user@example.test"); expect(mail.bcc).toBeUndefined();
    expect(parsed.origin).toBe(origin); expect(parsed.pathname).toBe("/magic-link"); expect(parsed.search).toBe("");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = db.prepare("SELECT * FROM magic_links").get() as any;
    expect(row.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(token); expect(JSON.stringify(row)).not.toContain(binding.split("=")[1]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: true, secure: false }));
    expect(JSON.stringify(db.prepare("SELECT * FROM mail_logs").all())).not.toContain(token);
    const exchange = await post("consume", { token }, binding);
    expect(exchange.status).toBe(200);
    const body = await exchange.json(); expect(body.stage).toBe("mfa_verify");
    const session = cookie(exchange, "wp_session");
    const restricted = await fetch(origin + "/api/v1/metrics", { headers: { cookie: session } });
    expect(restricted.status).toBe(401);
    const verify = await fetch(origin + "/api/v1/auth/mfa/verify", { method: "POST", headers: {
      "content-type": "application/json", origin, cookie: session, "x-csrf-token": body.csrf,
    }, body: JSON.stringify({ code: new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate() }) });
    expect(verify.status).toBe(200); expect((await verify.json()).stage).toBe("full");
    expect((await post("consume", { token }, binding)).status).toBe(401);
    expect(JSON.stringify(db.prepare("SELECT * FROM audit_events").all())).not.toContain(token);
  });

  it("does not consume on GET, rejects missing/wrong browser binding and rejects login CSRF", async () => {
    const { binding, token } = await requestLink();
    const scanner = await fetch(origin + "/api/v1/auth/magic-link/consume");
    expect(scanner.status).not.toBe(200);
    expect((await post("consume", { token })).status).toBe(401);
    expect((await post("consume", { token }, "wp_magic_browser=" + "a".repeat(43))).status).toBe(401);
    expect((await post("consume", { token }, binding, { origin: "https://evil.example" })).status).toBe(403);
    const noOrigin = await fetch(origin + "/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json", cookie: binding }, body: JSON.stringify({ token }) });
    expect(noOrigin.status).toBe(403);
    expect((await post("consume", { token }, binding)).status).toBe(200);
  });

  it("rejects expiry and concurrent replay", async () => {
    const expired = await requestLink();
    db.exec("UPDATE magic_links SET expires_at=0");
    expect((await post("consume", { token: expired.token }, expired.binding)).status).toBe(401);
    const latest = await requestLink();
    const results = await Promise.all([post("consume", { token: latest.token }, latest.binding), post("consume", { token: latest.token }, latest.binding)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 401]);
  });

  it.each([
    ["disabled", "status='disabled'"], ["locked", "status='locked'"],
    ["future lock", "locked_until=datetime('now','+1 hour')"], ["sso", "auth_provider='sso'"],
    ["MFA disabled", "mfa_required=0"], ["MFA reset", "mfa_enrolled_at=NULL"],
    ["first password change", "must_change_password=1"], ["tenant changed", "tenant_id='b'"],
    ["email changed", "email='other@example.test'"], ["session revoked", "session_version=session_version+1"],
  ])("rejects a token if %s after issuance", async (_name, mutation) => {
    const { token, binding } = await requestLink();
    db.exec(`UPDATE users SET ${mutation} WHERE id='u'`);
    expect((await post("consume", { token }, binding)).status).toBe(401);
  });

  it.each(["status='disabled'", "status='locked'", "locked_until=datetime('now','+1 hour')", "auth_provider='sso'", "mfa_required=0", "mfa_enrolled_at=NULL", "must_change_password=1"])("does not send to ineligible accounts: %s", async mutation => {
    db.exec(`UPDATE users SET ${mutation} WHERE id='u'`);
    const response = await post("request", { email: "user@example.test" });
    expect(response.status).toBe(202); expect(await response.json()).toEqual({ ok: true });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(mocks.sendMail).not.toHaveBeenCalled(); expect(db.prepare("SELECT * FROM magic_links").all()).toEqual([]);
  });

  it("returns the same response for unknown and throttled addresses, despite forged forwarding headers", async () => {
    for (let i = 0; i < 5; i++) {
      const response = await post("request", { email: "missing@example.test" }, undefined, { "x-forwarded-for": `192.0.2.${i}` });
      expect(response.status).toBe(202); expect(await response.json()).toEqual({ ok: true });
      expect(cookie(response, "wp_magic_browser")).toMatch(/^wp_magic_browser=/);
    }
    expect(mocks.sendMail).not.toHaveBeenCalled();
    const row = db.prepare("SELECT count FROM magic_link_limits WHERE key LIKE 'request:ip:%'").get() as any;
    expect(row.count).toBe(3);
  });

  it("preserves the first link and binding across same-browser retries, invalid input, and throttling", async () => {
    const first = await requestLink();
    const original = db.prepare("SELECT * FROM magic_links WHERE user_id='u'").get();
    for (let i = 0; i < 3; i++) {
      const retry = await post("request", { email: "user@example.test" }, first.binding);
      expect(retry.status).toBe(202); expect(await retry.json()).toEqual({ ok: true });
      expect(cookie(retry, "wp_magic_browser")).toBe(first.binding);
    }
    // The fourth request to this account was denied and must not increment global.
    expect((db.prepare("SELECT count FROM magic_link_limits WHERE key='request:global'").get() as any).count).toBe(3);
    const invalid = await post("request", { email: "not-an-email" }, first.binding);
    expect(invalid.status).toBe(202); expect(cookie(invalid, "wp_magic_browser")).toBe(first.binding);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT * FROM magic_links WHERE user_id='u'").get()).toEqual(original);
    expect((await post("consume", { token: first.token }, first.binding)).status).toBe(200);
  });

  it("preserves a working binding and link when the request IP is throttled", async () => {
    const first = await requestLink();
    for (let i = 0; i < 19; i++) {
      expect((await post("request", { email: `missing-${i}@example.test` })).status).toBe(202);
    }
    const denied = await post("request", { email: "user@example.test" }, first.binding);
    expect(denied.status).toBe(202); expect(await denied.json()).toEqual({ ok: true });
    expect(cookie(denied, "wp_magic_browser")).toBe(first.binding);
    expect((db.prepare("SELECT count FROM magic_link_limits WHERE key='request:global'").get() as any).count).toBe(20);
    expect((await post("consume", { token: first.token }, first.binding)).status).toBe(200);
  });

  it("does not overwrite a live link from a different browser", async () => {
    const first = await requestLink();
    const original = db.prepare("SELECT * FROM magic_links WHERE user_id='u'").get();
    const other = await post("request", { email: "user@example.test" });
    expect(other.status).toBe(202); expect(await other.json()).toEqual({ ok: true });
    const otherBinding = cookie(other, "wp_magic_browser");
    expect(otherBinding).not.toBe(first.binding);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT * FROM magic_links WHERE user_id='u'").get()).toEqual(original);
    expect((await post("consume", { token: first.token }, otherBinding)).status).toBe(401);
    expect((await post("consume", { token: first.token }, first.binding)).status).toBe(200);
    const replacement = await requestLink("user@example.test", otherBinding);
    expect(replacement.binding).toBe(otherBinding);
    expect((await post("consume", { token: replacement.token }, otherBinding)).status).toBe(200);
  });

  it("allows another browser to issue a link after expiry", async () => {
    const first = await requestLink();
    db.exec("UPDATE magic_links SET expires_at=0");
    const replacement = await requestLink();
    expect(replacement.binding).not.toBe(first.binding);
    expect((await post("consume", { token: first.token }, first.binding)).status).toBe(401);
    expect((await post("consume", { token: replacement.token }, replacement.binding)).status).toBe(200);
  });

  it("preserves a live link and cookie when the browser requests an unrelated account", async () => {
    db.prepare(`INSERT INTO users(id,tenant_id,email,display_name,role,status,auth_provider,password_hash,mfa_required,mfa_enrolled_at,mfa_secret_encrypted)
      VALUES ('other','a','other@example.test','Other','manager','active','local','password-hash',1,datetime('now'),?)`).run(encryptSecret(secret));
    const first = await requestLink();
    const original = db.prepare("SELECT * FROM magic_links WHERE user_id='u'").get();
    const other = await requestLink("other@example.test", first.binding);
    expect(other.binding).toBe(first.binding);
    expect(db.prepare("SELECT * FROM magic_links WHERE user_id='u'").get()).toEqual(original);
    expect((await post("consume", { token: first.token }, first.binding)).status).toBe(200);
  });

  it("does not replace a potentially valid duplicate-name browser cookie", async () => {
    const first = await requestLink();
    const duplicate = `${first.binding}; wp_magic_browser=${"a".repeat(43)}`;
    const retry = await post("request", { email: "user@example.test" }, duplicate);
    expect(retry.status).toBe(202); expect(await retry.json()).toEqual({ ok: true });
    expect(retry.headers.getSetCookie().some(v => v.startsWith("wp_magic_browser="))).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect((await post("consume", { token: first.token }, first.binding)).status).toBe(200);
  });

  it("does not let 501 forged-header requests from one IP exhaust the global bucket", async () => {
    for (let i = 0; i < 501; i++) {
      const response = await post("request", { email: `missing${i}@example.test` }, undefined, {
        "x-forwarded-for": `192.0.2.${i % 255}`, "cf-connecting-ip": `198.51.100.${i % 255}`,
      });
      expect(response.status).toBe(202); expect(await response.json()).toEqual({ ok: true });
    }
    expect((db.prepare("SELECT count FROM magic_link_limits WHERE key='request:global'").get() as any).count).toBe(20);
    expect((db.prepare("SELECT count FROM magic_link_limits WHERE key LIKE 'request:ip:%'").get() as any).count).toBe(20);
    expect((db.prepare("SELECT count(*) AS n FROM magic_link_limits").get() as any).n).toBe(22);

    // A second real socket address, not a forwarding header, still has capacity.
    const payload = JSON.stringify({ email: "user@example.test" });
    const second = await new Promise<{ status: number | undefined; body: string; cookies: string[] }>((resolve, reject) => {
      const req = httpRequest(`${origin}/api/v1/auth/magic-link/request`, {
        method: "POST", localAddress: "127.0.0.2", headers: { "content-type": "application/json", origin, "content-length": Buffer.byteLength(payload) },
      }, res => {
        let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body, cookies: res.headers["set-cookie"] || [] }));
      });
      req.on("error", reject); req.end(payload);
    });
    expect(second.status).toBe(202); expect(JSON.parse(second.body)).toEqual({ ok: true });
    const binding = second.cookies.find(v => v.startsWith("wp_magic_browser="))!.split(";")[0];
    await vi.waitFor(() => expect(mocks.sendMail).toHaveBeenCalledTimes(1));
    const link = mocks.sendMail.mock.calls[0][0].text.match(/https?:\/\/[^\s]+/)[0] as string;
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token")!;
    expect((await post("consume", { token }, binding)).status).toBe(200);
    expect((db.prepare("SELECT count FROM magic_link_limits WHERE key='request:global'").get() as any).count).toBe(21);
    await vi.waitFor(() => expect((db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='auth.magic_link.requested'").get() as any).n).toBe(502));
  }, 30000);

  it("caps active links and cleans expired links before admitting a new issuance", async () => {
    const seed = db.transaction(() => {
      const user = db.prepare("INSERT INTO users(id,email,display_name,role) VALUES (?,?,?,?)");
      const link = db.prepare("INSERT INTO magic_links(user_id,token_hash,browser_hash,session_version,email,expires_at) VALUES (?,?,?,0,?,?)");
      for (let i = 0; i < 500; i++) {
        const id = `seed-${i}`, email = `${id}@example.test`;
        user.run(id, email, id, "manager");
        link.run(id, `hash-${i}`, "browser-hash", email, Date.now() + 600000);
      }
    });
    seed();
    const blocked = await post("request", { email: "user@example.test" });
    expect(blocked.status).toBe(202); expect(await blocked.json()).toEqual({ ok: true });
    const binding = cookie(blocked, "wp_magic_browser");
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect((db.prepare("SELECT count(*) AS n FROM magic_links").get() as any).n).toBe(500);
    db.prepare("UPDATE magic_links SET expires_at=0 WHERE user_id=?").run("seed-0");
    const issued = await requestLink("user@example.test", binding);
    expect((db.prepare("SELECT count(*) AS n FROM magic_links").get() as any).n).toBe(500);
    expect(db.prepare("SELECT 1 FROM magic_links WHERE user_id='seed-0'").get()).toBeUndefined();
    expect((await post("consume", { token: issued.token }, issued.binding)).status).toBe(200);
  });

  it("refuses to replace a pending session and preserves the unused link", async () => {
    const first = await requestLink();
    const exchange = await post("consume", { token: first.token }, first.binding);
    const session = cookie(exchange, "wp_session"); const csrf = (await exchange.json()).csrf;
    const second = await requestLink();
    const rejected = await post("consume", { token: second.token }, `${second.binding}; ${session}`, { "x-csrf-token": csrf });
    expect(rejected.status).toBe(401);
    expect((await post("consume", { token: second.token }, second.binding)).status).toBe(200);
  });

  it("uses the configured origin rather than an attacker-controlled Host", async () => {
    const response = await post("request", { email: "user@example.test" }, undefined, { host: "attacker.example" });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(mocks.sendMail).toHaveBeenCalledTimes(1));
    expect(mocks.sendMail.mock.calls[0][0].text).toContain(`${origin}/magic-link#token=`);
    expect(mocks.sendMail.mock.calls[0][0].text).not.toContain("attacker.example");
  });

  it("does not await a stalled provider before returning the generic response", async () => {
    let finish!: () => void;
    mocks.sendMail.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({}); }));
    const response = await Promise.race([
      post("request", { email: "user@example.test" }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("provider blocked response")), 500)),
    ]);
    expect(response.status).toBe(202); expect(await response.json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(mocks.sendMail).toHaveBeenCalledTimes(1));
    finish(); await vi.waitFor(() => expect(db.prepare("SELECT * FROM mail_logs").all()).toHaveLength(1));
  });

  it("rejects malformed credential JSON without echoing the input", async () => {
    const marker = "not-a-real-token-should-not-be-echoed";
    const response = await fetch(origin + "/api/v1/auth/magic-link/consume", { method: "POST", headers: {
      "content-type": "application/json", origin,
    }, body: `{\"token\":\"${marker}` });
    expect(response.status).toBe(400); expect(await response.text()).not.toContain(marker);
  });

  it("does not dispatch with configured BCC or simulation and never retains the link", async () => {
    db.exec("UPDATE email_config SET global_bcc='archive@example.test'");
    const a = await post("request", { email: "user@example.test" }); expect(a.status).toBe(202);
    await vi.waitFor(() => expect(db.prepare("SELECT * FROM mail_logs").all()).toHaveLength(1));
    expect(mocks.sendMail).not.toHaveBeenCalled(); expect(db.prepare("SELECT * FROM magic_links").all()).toHaveLength(0);
    db.exec("UPDATE email_config SET global_bcc=NULL"); process.env.EMAIL_SIMULATED = "true";
    const b = await post("request", { email: "user@example.test" }); expect(b.status).toBe(202);
    await vi.waitFor(() => expect(db.prepare("SELECT * FROM mail_logs").all()).toHaveLength(2));
    expect(mocks.sendMail).not.toHaveBeenCalled(); expect(db.prepare("SELECT * FROM magic_links").all()).toHaveLength(0);
    expect(JSON.stringify(db.prepare("SELECT * FROM mail_logs").all())).not.toContain("#token=");
  });

  it("fails closed if APP_ORIGIN is not exact HTTPS outside isolated tests", async () => {
    process.env.APP_ORIGIN = "https://portal.example.test/path";
    expect((await post("request", { email: "user@example.test" })).status).toBe(403);
    process.env.APP_ORIGIN = "http://portal.example.test";
    expect((await post("request", { email: "user@example.test" }, undefined, { origin: "http://portal.example.test" })).status).toBe(403);
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });
});
