import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type Database from "better-sqlite3";
import { SignJWT } from "jose";
import Papa from "papaparse";

const mocks = vi.hoisted(() => ({ resend: vi.fn() }));
vi.mock("./email", () => ({ sendEmail: vi.fn(), resendMailLog: mocks.resend, emailCircuitStatus: vi.fn() }));

const secret = "audit-isolation-test-secret-at-least-32-bytes";
const csrf = "audit-test-csrf";
const originalEnv = { DATA_DIR: process.env.DATA_DIR, SQLITE_PATH: process.env.SQLITE_PATH, APP_SESSION_SECRET: process.env.APP_SESSION_SECRET };
let dir: string, db: Database.Database, server: Server, origin: string;
const cookies: Record<string, string> = {};

async function token(id: string, role: string, tenantId: string | null) {
  return new SignJWT({ role, tenantId, csrf, stage: "full", sessionVersion: 0, authProvider: "local", status: "active" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(id).setIssuer("welfare-pride-hpp")
    .setAudience("welfare-pride-hpp-web").setExpirationTime("1h").sign(new TextEncoder().encode(secret));
}
async function request(url: string, who?: string, method = "GET", body?: object) {
  const headers: Record<string, string> = {};
  if (who) { headers.cookie = cookies[who]; headers["x-csrf-token"] = csrf; }
  if (body) headers["content-type"] = "application/json";
  return fetch(origin + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}
async function json(url: string, who?: string, method = "GET", body?: object) {
  const response = await request(url, who, method, body);
  return { response, data: await response.json() };
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "report-audit-isolation-"));
  process.env.DATA_DIR = dir;
  process.env.SQLITE_PATH = path.join(dir, "isolated.sqlite");
  process.env.APP_SESSION_SECRET = secret;
  const repo = await import("./repository");
  db = repo.db;
  repo.runMigrations();
  db.exec("INSERT INTO tenants(id,name) VALUES ('a','Tenant A'),('b','Tenant B')");
  const users = [
    ["adminA", "a", "admin"], ["adminB", "b", "admin"], ["adminNull", null, "admin"],
    ["managerA", "a", "manager"], ["superA", "a", "super_admin"], ["superNull", null, "super_admin"],
  ] as const;
  const insert = db.prepare("INSERT INTO users(id,tenant_id,email,display_name,role,status,auth_provider,mfa_enrolled_at,mfa_secret_encrypted) VALUES (?,?,?,?,?,'active','local',datetime('now'),'test-secret')");
  for (const [id, tenant, role] of users) {
    insert.run(id, tenant, `${id}@example.invalid`, id, role);
    cookies[id] = `wp_session=${await token(id, role, tenant)}`;
  }
  // A correctly signed but stale/forged tenant claim must not override the live account.
  cookies.forged = `wp_session=${await token("adminA", "admin", "b")}`;
  const { app } = await import("./index");
  server = await new Promise<Server>(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => {
  db.exec("DELETE FROM audit_events; DELETE FROM monthly_metrics; DELETE FROM mail_logs;");
  mocks.resend.mockReset();
  mocks.resend.mockResolvedValue({ ok: true, provider: "test", logId: "resent" });
});

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (db) db.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function seedAudits() {
  const insert = db.prepare(`INSERT INTO audit_events
    (id,request_id,tenant_id,action,severity,resource_type,resource_id,ip_hash,method,status_code,metadata,occurred_at)
    VALUES (?,?,?,'fixture.metric','info','metrics',?,'test','PUT',200,?,?)`);
  insert.run("a1", "req-a1", "a", "=A_FORMULA", JSON.stringify({ note: "A_ONLY_NOTE", calls: 111 }), "2097-01-01 00:00:00");
  insert.run("a2", "req-a2", "a", "a2", JSON.stringify({ note: "A_SECOND_NOTE", calls: 112 }), "2098-01-01 00:00:00");
  insert.run("b1", "req-b1", "b", "b1", JSON.stringify({ note: "B_PRIVATE_NOTE", calls: 99991 }), "2099-01-01 00:00:00");
  insert.run("n1", "req-n1", null, "n1", JSON.stringify({ note: "NULL_PRIVATE_NOTE" }), "2096-01-01 00:00:00");
}

function metric(calls: number, notes: string) {
  return { calls_round1: calls, calls_round2: 0, calls_round3: 0, aca_yes: 0, aca_no: 0,
    head_of_household: 0, staff_members: 0, calls_jhpp: 0, calls_wr: 0, notes };
}

describe("audit and mail log tenant isolation", () => {
  it("isolates actual metric audit before/after state and metric notes between tenants", async () => {
    for (const [who, calls, note] of [["adminA", 111, "A_PRIVATE_METRIC"], ["adminB", 99991, "B_PRIVATE_METRIC"]] as const) {
      expect((await request("/api/v1/metrics/2025/1", who, "PUT", metric(calls, note))).status).toBe(200);
      expect((await request("/api/v1/metrics/2025/1", who, "PUT", metric(calls + 1, note + "_UPDATED"))).status).toBe(200);
    }
    for (const [who, own, other] of [["adminA", "A_PRIVATE_METRIC", "B_PRIVATE_METRIC"], ["adminB", "B_PRIVATE_METRIC", "A_PRIVATE_METRIC"]]) {
      const { response, data } = await json("/api/v1/admin/audit?action=metrics.updated", who);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(data.total).toBe(1);
      expect(data.events).toHaveLength(1);
      expect(data.events[0].before_state).toContain(own);
      expect(data.events[0].after_state).toContain(own + "_UPDATED");
      const expectedCalls = who === "adminA" ? 111 : 99991;
      expect(JSON.parse(data.events[0].before_state).calls_round1).toBe(expectedCalls);
      expect(JSON.parse(data.events[0].after_state).calls_round1).toBe(expectedCalls + 1);
      expect(JSON.stringify(data)).not.toContain(other);
      const metrics = await json("/api/v1/metrics?tenantId=" + (who === "adminA" ? "b" : "a"), who);
      expect(JSON.stringify(metrics.data)).toContain(own);
      expect(JSON.stringify(metrics.data)).not.toContain(other);
    }
  });

  it("applies the authenticated tenant before filtering, count, limit and offset, ignoring supplied tenants", async () => {
    seedAudits();
    const { response, data } = await json("/api/v1/admin/audit?action=fixture.metric&tenantId=b&limit=1&offset=0", "adminA");
    expect(response.status).toBe(200);
    expect(data.total).toBe(2);
    expect(data.events.map((e: { id: string }) => e.id)).toEqual(["a2"]);
    expect(JSON.stringify(data)).not.toContain("B_PRIVATE_NOTE");
    const next = await json("/api/v1/admin/audit?action=fixture.metric&tenant_id=b&limit=1&offset=1", "adminA");
    expect(next.data.total).toBe(2);
    expect(next.data.events.map((e: { id: string }) => e.id)).toEqual(["a1"]);
    const search = await json("/api/v1/admin/audit?action=fixture.metric&search=B_PRIVATE_NOTE", "adminA");
    expect(search.data).toEqual({ total: 0, events: [] });
    const b = await json("/api/v1/admin/audit?action=fixture.metric&tenantId=a", "adminB");
    expect(b.data.total).toBe(1);
    expect(b.data.events.map((e: { id: string }) => e.id)).toEqual(["b1"]);
    expect((await request("/api/v1/admin/audit", "forged")).status).toBe(401);
    expect((await request("/api/v1/admin/audit", "managerA")).status).toBe(403);
    expect((await request("/api/v1/admin/audit")).status).toBe(401);
  });

  it("isolates CSV exports before limit, ignores caller tenant and escapes spreadsheet formulae", async () => {
    seedAudits();
    const limited = await request("/api/v1/admin/audit/export?tenantId=b&limit=1", "adminA");
    expect(limited.status).toBe(200);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(limited.headers.get("content-type")).toContain("text/csv");
    const limitedText = await limited.text();
    expect(limitedText).toContain("A_SECOND_NOTE");
    expect(limitedText).not.toContain("B_PRIVATE_NOTE");
    const full = await request("/api/v1/admin/audit/export?tenant_id=b", "adminA");
    const fullText = await full.text();
    expect(fullText).toContain("A_ONLY_NOTE");
    expect(fullText).not.toContain("B_PRIVATE_NOTE");
    expect(fullText).not.toContain("NULL_PRIVATE_NOTE");
    const parsed = Papa.parse<Record<string, string>>(fullText, { header: true }).data;
    expect(parsed.find(row => row["Request ID"] === "req-a1")?.["Resource ID"]).toBe("'=A_FORMULA");
    const foreign = await request("/api/v1/admin/audit/export?tenantId=a", "adminB");
    const foreignText = await foreign.text();
    expect(foreignText).toContain("B_PRIVATE_NOTE");
    expect(foreignText).not.toContain("A_ONLY_NOTE");
    expect((await request("/api/v1/admin/audit/export", "forged")).status).toBe(401);
    expect((await request("/api/v1/admin/audit/export", "managerA")).status).toBe(403);
    expect((await request("/api/v1/admin/audit/export")).status).toBe(401);
  });

  it("fails closed for a tenantless admin, but both scoped and tenantless super admins are global", async () => {
    seedAudits();
    for (const route of ["/api/v1/admin/audit?tenantId=b", "/api/v1/admin/audit/export?tenantId=b"]) {
      const denied = await json(route, "adminNull");
      expect(denied.response.status).toBe(403);
      expect(denied.data.error).toBe("TENANT_REQUIRED");
      expect(JSON.stringify(denied.data)).not.toContain("PRIVATE_NOTE");
    }
    for (const who of ["superA", "superNull"]) {
      const list = await json("/api/v1/admin/audit?action=fixture.metric&tenantId=a", who);
      expect(list.response.status).toBe(200);
      expect(list.data.total).toBe(4);
      expect(list.data.events.map((e: { id: string }) => e.id).sort()).toEqual(["a1", "a2", "b1", "n1"]);
      const response = await request("/api/v1/admin/audit/export?tenantId=a", who);
      expect(response.status).toBe(200);
      const text = await response.text();
      for (const marker of ["A_ONLY_NOTE", "B_PRIVATE_NOTE", "NULL_PRIVATE_NOTE"]) expect(text).toContain(marker);
    }
  });

  it("allows only super admins to list or resend logs with no reliable tenant provenance", async () => {
    db.prepare("INSERT INTO mail_logs(id,provider,recipient,subject,status) VALUES (?,?,?,?,?)")
      .run("log-b", "test", "recipient-b@example.invalid", "Private report", "failed");
    for (const who of ["adminA", "adminB", "adminNull", "managerA"]) {
      const list = await json("/api/v1/admin/mail-logs?tenantId=b", who);
      expect(list.response.status).toBe(403);
      expect(list.response.headers.get("cache-control")).toBe("no-store");
      expect(JSON.stringify(list.data)).not.toContain("recipient-b@example.invalid");
      expect((await request("/api/v1/admin/mail-logs/log-b/resend", who, "POST", {})).status).toBe(403);
    }
    expect(mocks.resend).not.toHaveBeenCalled();
    expect((await request("/api/v1/admin/mail-logs")).status).toBe(401);
    expect((await request("/api/v1/admin/mail-logs/log-b/resend", undefined, "POST", {})).status).toBe(401);
    for (const who of ["superA", "superNull"]) {
      const list = await json("/api/v1/admin/mail-logs", who);
      expect(list.response.status).toBe(200);
      expect(list.data.logs.map((l: { id: string }) => l.id)).toEqual(["log-b"]);
      expect((await request("/api/v1/admin/mail-logs/log-b/resend", who, "POST", {})).status).toBe(200);
    }
    expect(mocks.resend).toHaveBeenCalledTimes(2);
    expect(mocks.resend).toHaveBeenCalledWith("log-b");
  });
});
