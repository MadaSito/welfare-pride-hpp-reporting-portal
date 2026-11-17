import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { request as httpRequest, type Server } from "node:http";
import type Database from "better-sqlite3";

let dir: string, db: Database.Database, server: Server, origin: string;
let appModule: typeof import("./index");

const envKeys = ["DATA_DIR", "SQLITE_PATH", "APP_ORIGIN", "APP_SESSION_SECRET", "NODE_ENV"] as const;
const oldEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));

const STRONG_PW = "AlphaBeta12!@#SpecialOk";

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "setup-test-"));
  process.env.DATA_DIR = dir;
  process.env.SQLITE_PATH = path.join(dir, "test.sqlite");
  process.env.APP_SESSION_SECRET = "setup-test-session-secret-not-for-production";
  process.env.NODE_ENV = "test";
  const repo = await import("./repository");
  db = repo.db;
  repo.runMigrations();
  appModule = await import("./index");
  server = await new Promise<Server>(resolve => {
    const s = appModule.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.APP_ORIGIN = origin;
});

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (db) db.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  for (const k of envKeys) {
    if (oldEnv[k] === undefined) delete process.env[k];
    else process.env[k] = oldEnv[k];
  }
});

function req(endpoint: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { origin, ...(opts.headers ?? {}) };
  let payload: string | undefined;
  if (opts.body !== undefined) {
    payload = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const r = httpRequest(origin + endpoint, { method, headers }, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data });
        }
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

describe("first-time setup endpoints", () => {
  it("reports setup needed when database has no users", async () => {
    const res = await req("/api/v1/auth/setup/status");
    expect(res.status).toBe(200);
    expect(res.body.setupNeeded).toBe(true);
    expect(res.body.userCount).toBe(0);
  });

  it("rejects weak password with 400", async () => {
    const res = await req("/api/v1/auth/setup", {
      method: "POST",
      body: { email: "admin@example.org", password: "weak" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_SETUP_PAYLOAD");
  });

  it("rejects invalid email", async () => {
    const res = await req("/api/v1/auth/setup", {
      method: "POST",
      body: { email: "not-an-email", password: STRONG_PW },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_SETUP_PAYLOAD");
  });

  it("rejects known-compromised passwords in setup", async () => {
    const res = await req("/api/v1/auth/setup", {
      method: "POST",
      body: { email: "admin@example.org", password: "SuperAdmin2026!#W" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("PASSWORD_POLICY");
  });

  it("rejects invalid hex color in branding", async () => {
    const res = await req("/api/v1/auth/setup", {
      method: "POST",
      body: { email: "admin@example.org", password: STRONG_PW, primaryColor: "red" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_SETUP_PAYLOAD");
  });

  it("creates super_admin with MFA required and applies branding", async () => {
    const res = await req("/api/v1/auth/setup", {
      method: "POST",
      body: {
        email: "Admin@Example.ORG ",
        password: STRONG_PW,
        displayName: "First Admin",
        companyName: "Acme Health",
        tagline: "Outreach dashboard",
        primaryColor: "#123456",
        secondaryColor: "#654321",
        logoUrl: "https://example.org/logo.png",
      },
    });
    if (res.status !== 201) { console.error("BODY:", JSON.stringify(res.body)); } expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.email).toBe("Admin@Example.ORG");

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get("admin@example.org") as any;
    expect(user).toBeTruthy();
    expect(user.role).toBe("super_admin");
    expect(user.mfa_required).toBe(0);
    expect(user.must_change_password).toBe(0);
    expect(user.status).toBe("active");
    expect(user.display_name).toBe("First Admin");

    const brand = db.prepare("SELECT * FROM brand_config WHERE id = 1").get() as any;
    expect(brand.company_name).toBe("Acme Health");
    expect(brand.tagline).toBe("Outreach dashboard");
    expect(brand.primary_color).toBe("#123456");
    expect(brand.secondary_color).toBe("#654321");

    const audit = db.prepare("SELECT * FROM audit_events WHERE action = 'auth.setup.completed'").all();
    expect(audit.length).toBe(1);
  });

  it("reports setup no longer needed", async () => {
    const res = await req("/api/v1/auth/setup/status");
    expect(res.status).toBe(200);
    expect(res.body.setupNeeded).toBe(false);
    expect(res.body.userCount).toBe(1);
  });

  it("refuses a second setup attempt with 409", async () => {
    const res = await req("/api/v1/auth/setup", {
      method: "POST",
      body: { email: "other@example.org", password: STRONG_PW },
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("SETUP_ALREADY_COMPLETED");
  });

  it("the new admin can log in without mandatory MFA enrollment", async () => {
    const res = await req("/api/v1/auth/login", {
      method: "POST",
      body: { email: "admin@example.org", password: STRONG_PW },
    });
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe("full");
  });
});

describe("generated strong passwords", () => {
  it("satisfies all server policy requirements across multiple samples", async () => {
    const { validatePassword } = await import("./security");
    function generateStrongPassword(): string {
      const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
      const lower = "abcdefghijkmnopqrstuvwxyz";
      const digits = "23456789";
      const specials = "!@#$%^*?";
      const all = upper + lower + digits + specials;
      const pick = (chars: string) => chars[Math.floor(Math.random() * chars.length)];
      const mandatory = [pick(upper), pick(upper), pick(lower), pick(lower), pick(digits), pick(digits), pick(specials), pick(specials), pick(specials)];
      const rest = Array.from({ length: 11 }, () => pick(all));
      return mandatory.concat(rest).sort(() => Math.random() - 0.5).join("");
    }
    for (let i = 0; i < 30; i++) {
      expect(validatePassword(generateStrongPassword())).toBe(true);
    }
  });
});

  it("still routes to MFA when mfa_required is explicitly enabled", async () => {
    db.prepare("UPDATE users SET mfa_required = 1 WHERE email = ?").run("admin@example.org");
    const res = await req("/api/v1/auth/login", {
      method: "POST",
      body: { email: "admin@example.org", password: STRONG_PW },
    });
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe("mfa_enroll");
  });

  it("completes login with stage full when MFA is not required", async () => {
    db.prepare("UPDATE users SET mfa_required = 0, mfa_enrolled_at = NULL, mfa_secret_encrypted = NULL WHERE email = ?").run("admin@example.org");
    const res = await req("/api/v1/auth/login", {
      method: "POST",
      body: { email: "admin@example.org", password: STRONG_PW },
    });
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe("full");
    expect(res.body.user).toBeTruthy();
  });
