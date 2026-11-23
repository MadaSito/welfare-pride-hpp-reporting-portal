import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";
import Database from "better-sqlite3";
import { SignJWT } from "jose";
import Papa from "papaparse";

let dir: string, origin: string, api: Server;
let repo: typeof import("./repository");
const cookies: Record<string, string> = {};
const secret = "monthly-fields-test-only-secret-0123456789";
const sample = { staff_members: 3, total_calls: 99, members_reached: 42, referrals: 7, calls_round1: 2, calls_round2: 3, calls_round3: 0 };
async function request(url: string, who = "manager", method = "GET", body?: object, csrf = true) {
  const response = await fetch(origin + url, { method, headers: {
    cookie: cookies[who], ...(csrf ? { "x-csrf-token": "test-csrf" } : {}), ...(body ? { "content-type": "application/json" } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  return response;
}
async function json(url: string, who = "manager", method = "GET", body?: object, csrf = true) {
  const response = await request(url, who, method, body, csrf);
  return { status: response.status, body: await response.json() };
}
beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "wp-monthly-fields-test-"));
  process.env.DATA_DIR = dir;
  process.env.SQLITE_PATH = "";
  process.env.APP_SESSION_SECRET = secret;
  process.env.REQUIRE_LOCAL_MFA = "false";
  process.env.REPORT_RATELIMIT_MAX = "1000";
  repo = await import("./repository");
  // Initial schema setup adds no users, metric rows, report rows or tenants.
  for (const table of ["users", "monthly_metrics", "reports", "tenants"]) {
    expect((repo.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
  }
  repo.db.exec("INSERT INTO tenants(id,name) VALUES ('a','Test Tenant A'),('b','Test Tenant B')");
  for (const [id, tenant, role] of [["manager", "a", "manager"], ["viewer", "a", "view_only"], ["foreign", "b", "manager"]]) {
    repo.db.prepare("INSERT INTO users(id,tenant_id,email,display_name,role,status,auth_provider) VALUES (?,?,?,?,?,'active','local')")
      .run(id, tenant, `${id}@test.invalid`, id, role);
    const token = await new SignJWT({ role, tenantId: tenant, csrf: "test-csrf", stage: "full", sessionVersion: 0, authProvider: "local", status: "active" })
      .setProtectedHeader({ alg: "HS256" }).setSubject(id).setIssuer("welfare-pride-hpp").setAudience("welfare-pride-hpp-web").setExpirationTime("1h").sign(new TextEncoder().encode(secret));
    cookies[id] = `wp_session=${token}`;
  }
  const { app } = await import("./index");
  api = await new Promise<Server>(resolve => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  origin = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
}, 30000);
beforeEach(() => { repo.db.exec("DELETE FROM monthly_metrics; DELETE FROM audit_events"); });
afterAll(async () => {
  if (api) await new Promise<void>(resolve => api.close(() => resolve()));
  if (repo) repo.db.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("independent seven-field monthly reporting", () => {
  it("saves all seven fields without supplemental fields and uses independent totals in reads, dashboard and audit", async () => {
    const saved = await json("/api/v1/metrics/2024/1", "manager", "PUT", sample);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject(sample);
    expect(saved.body.kpis).toMatchObject({ totalCalls: 99, membersReached: 42, totalReferrals: 7 });
    expect(saved.body.aca_yes).toBe(0);
    expect(saved.body.tenant_id).toBe("a");
    expect((await json("/api/v1/metrics/2024/1")).body.kpis.totalCalls).toBe(99);
    const dashboard = await json("/api/v1/dashboard/summary?year=2024");
    expect(dashboard.body.totals).toMatchObject({ totalCalls: 99, members_reached: 42, totalReferrals: 7, calls_round1: 2, calls_round2: 3, calls_round3: 0 });
    expect(dashboard.body.monthlySeries[0]).toMatchObject({ totalCalls: 99, membersReached: 42, referrals: 7 });
    const audit = repo.db.prepare("SELECT after_state FROM audit_events WHERE action = 'metrics.created'").get() as { after_state: string };
    expect(JSON.parse(audit.after_state)).toMatchObject(sample);
  });

  it("preserves explicit zero instead of substituting completed-call or destination sums", async () => {
    const saved = await json("/api/v1/metrics/2024/2", "manager", "PUT", { ...sample, total_calls: 0, members_reached: 0, referrals: 0, calls_jhpp: 4, calls_wr: 6 });
    expect(saved.body.kpis).toMatchObject({ totalCalls: 0, membersReached: 0, totalReferrals: 0, jhppShare: 40, wrShare: 60 });
    expect((await json("/api/v1/dashboard/summary?year=2024")).body.totals.totalCalls).toBe(0);
  });

  it("preserves independent saved fields when an older client omits them", async () => {
    await json("/api/v1/metrics/2024/3", "manager", "PUT", sample);
    const saved = await json("/api/v1/metrics/2024/3", "manager", "PUT", { staff_members: 3, calls_round1: 5, calls_round2: 0, calls_round3: 0 });
    expect(saved.body).toMatchObject({ total_calls: 99, members_reached: 42, referrals: 7 });
    expect(saved.body.kpis.totalCalls).toBe(99);
  });

  it("rejects negative, fractional, nonnumeric and unsafe counts without storing a month", async () => {
    for (const field of Object.keys(sample)) {
      for (const bad of [-1, 1.5, "8", Number.MAX_SAFE_INTEGER + 1]) {
        expect((await json("/api/v1/metrics/2024/1", "manager", "PUT", { ...sample, [field]: bad })).status).toBe(400);
      }
    }
    expect((repo.db.prepare("SELECT count(*) AS n FROM monthly_metrics").get() as { n: number }).n).toBe(0);
  });

  it("retains view-only write restrictions, tenant isolation, and CSRF protection", async () => {
    expect((await json("/api/v1/metrics/2024/1", "viewer", "PUT", sample)).status).toBe(403);
    expect((await json("/api/v1/metrics/2024/1", "manager", "PUT", sample, false)).status).toBe(403);
    await json("/api/v1/metrics/2024/1", "manager", "PUT", { ...sample, tenantId: "b", tenant_id: "b" });
    expect((await json("/api/v1/metrics/2024/1", "foreign")).status).toBe(404);
    expect((await json("/api/v1/dashboard/summary?year=2024", "foreign")).body.monthsWithData).toBe(0);
    expect(repo.findMonthlyMetric(2024, 1, "a")?.tenant_id).toBe("a");
  });

  it("round-trips the seven canonical CSV fields, defaults present blanks to zero, and rejects malformed counts", async () => {
    await json("/api/v1/metrics/2024/4", "manager", "PUT", sample);
    const csv = await (await request("/api/v1/metrics/export?year=2024")).text();
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true });
    expect(parsed.meta.fields).toEqual(expect.arrayContaining(["Number of staff making the calls", "Total Number of Calls", "Total number of members REACHED", "Number of Referrals", "1st Round Completed Calls", "2nd Round Completed Calls", "3rd Round Completed Calls"]));
    expect(parsed.data[0]["Total Number of Calls"]).toBe("99");
    expect(parsed.data[0]["Total number of members REACHED"]).toBe("42");
    expect(parsed.data[0]["Number of Referrals"]).toBe("7");
    const imported = await json("/api/v1/metrics/import", "manager", "POST", { csv });
    expect(imported.body).toMatchObject({ imported: 1, errors: [] });
    const headers = "Reporting Year,Reporting Month,Number of staff making the calls,Total Number of Calls,Total number of members REACHED,Number of Referrals,1st Round Completed Calls,2nd Round Completed Calls,3rd Round Completed Calls";
    expect((await json("/api/v1/metrics/import", "manager", "POST", { csv: headers + "\n2024,5,3,10,,0,0,0,0" })).body.imported).toBe(1);
    expect(repo.findMonthlyMetric(2024, 5, "a")?.members_reached).toBe(0);
    const bad = await json("/api/v1/metrics/import", "manager", "POST", { csv: headers + "\n2024,6,3,garbage,1,0,0,0,0" });
    expect(bad.body.imported).toBe(0);
    expect(bad.body.errors).toHaveLength(1);
    expect(repo.findMonthlyMetric(2024, 6, "a")).toBeNull();
  });

  it("adds columns idempotently without changing historical counts, IDs, notes, dates or creating users/reports", () => {
    const legacy = mkdtempSync(path.join(os.tmpdir(), "wp-monthly-legacy-test-"));
    try {
      const old = new Database(path.join(legacy, "portal.db"));
      old.exec("CREATE TABLE monthly_metrics(id TEXT PRIMARY KEY,tenant_id TEXT,reporting_month INTEGER,reporting_year INTEGER,calls_round1 INTEGER DEFAULT 0,calls_round2 INTEGER DEFAULT 0,calls_round3 INTEGER DEFAULT 0,aca_yes INTEGER DEFAULT 0,aca_no INTEGER DEFAULT 0,head_of_household INTEGER DEFAULT 0,staff_members INTEGER DEFAULT 0,calls_jhpp INTEGER DEFAULT 0,calls_wr INTEGER DEFAULT 0,notes TEXT,entered_by TEXT,created_at TEXT,updated_at TEXT,UNIQUE(tenant_id,reporting_year,reporting_month)); INSERT INTO monthly_metrics(id,reporting_month,reporting_year,calls_round1,calls_round2,staff_members,calls_jhpp,calls_wr,notes,created_at,updated_at) VALUES('legacy',1,2024,2,3,3,1,1,'preserve','2024-01-01','2024-02-01');");
      old.close();
      const result = spawnSync("node", ["--import", "tsx", "--input-type=module", "-e", "import { db, runMigrations, computeKpis } from './server/repository.ts'; runMigrations();runMigrations();const m=db.prepare('SELECT * FROM monthly_metrics').get(); console.log(JSON.stringify({m,k:computeKpis(m),users:db.prepare('SELECT count(*) AS n FROM users').get().n,reports:db.prepare('SELECT count(*) AS n FROM reports').get().n}));db.close();"], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, DATA_DIR: legacy, SQLITE_PATH: "" } });
      expect(result.status).toBe(0);
      const data = JSON.parse(result.stdout.trim());
      expect(data.m).toMatchObject({ id: "legacy", total_calls: null, members_reached: 0, referrals: null, calls_round1: 2, calls_round2: 3, notes: "preserve", created_at: "2024-01-01", updated_at: "2024-02-01" });
      expect(data.k).toMatchObject({ totalCalls: 5, totalReferrals: 2 });
      expect(data.users).toBe(0);
      expect(data.reports).toBe(0);
    } finally { rmSync(legacy, { recursive: true, force: true }); }
  }, 20000);
});
