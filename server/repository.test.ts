import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
const isolated = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "welfare-repository-test-"));
  const oldData = process.env.DATA_DIR, oldSqlite = process.env.SQLITE_PATH;
  process.env.DATA_DIR = dir;
  process.env.SQLITE_PATH = path.join(dir, "test.sqlite");
  return { dir, oldData, oldSqlite };
});
import { computeKpis, type MonthlyMetric, db, runMigrations } from "./repository";
import { mayAssignRole, canManageTarget } from "./security";
import { ipRuleCheck } from "./cloudflare";
import { exportMetricsCsv } from "./backup";

beforeAll(() => runMigrations());
afterAll(() => {
  db.close();
  rmSync(isolated.dir, { recursive: true, force: true });
  if (isolated.oldData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = isolated.oldData;
  if (isolated.oldSqlite === undefined) delete process.env.SQLITE_PATH; else process.env.SQLITE_PATH = isolated.oldSqlite;
});

describe("computed KPIs", () => {
  it("computes totals and rates correctly from the 9 manual metrics", () => {
    const m: MonthlyMetric = {
      id: "t1",
      tenant_id: null,
      reporting_month: 3,
      reporting_year: 2026,
      calls_round1: 480,
      calls_round2: 220,
      calls_round3: 115,
      aca_yes: 332,
      aca_no: 162,
      head_of_household: 210,
      staff_members: 10,
      calls_jhpp: 160,
      calls_wr: 118,
      notes: null,
      entered_by: null,
      created_at: "",
      updated_at: "",
    };
    const k = computeKpis(m);
    expect(k.totalCalls).toBe(815);
    expect(k.round1Rate).toBe(58.9);
    expect(k.round2Rate).toBe(27);
    expect(k.round3Rate).toBe(14.1);
    expect(k.totalAca).toBe(494);
    expect(k.acaRate).toBe(67.2);
    expect(k.callsPerStaff).toBe(81.5);
    expect(k.totalReferrals).toBe(278);
    expect(k.jhppShare).toBe(57.6);
    expect(k.wrShare).toBe(42.4);
  });
});

describe("RBAC bounded privileges and super admin isolation", () => {
  it("enforces admin cannot assign super_admin or admin", () => {
    expect(mayAssignRole("admin", "super_admin")).toBe(false);
    expect(mayAssignRole("admin", "admin")).toBe(false);
    expect(mayAssignRole("admin", "manager")).toBe(true);
    expect(mayAssignRole("admin", "view_only")).toBe(true);
  });
  it("enforces admin cannot manage super_admin accounts", () => {
    expect(canManageTarget("admin", "super_admin")).toBe(false);
    expect(canManageTarget("admin", "admin")).toBe(false);
    expect(canManageTarget("admin", "view_only")).toBe(true);
  });
});

describe("CSV export formula safety", () => {
  it("escapes leading formula characters to prevent CSV injection", () => {
    const csv = exportMetricsCsv();
    // No line should start with raw =, +, -, @ after commas
    expect(csv).not.toMatch(/,\s*=[A-Za-z]/);
  });
});
