import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { ExecutivePage, previewReportBrand } from "../client/src/components/ExecutiveReportPreview";

let dir: string;
let repo: typeof import("./repository");
let reports: typeof import("./executive-report");
const previousEnv = { DATA_DIR: process.env.DATA_DIR, SQLITE_PATH: process.env.SQLITE_PATH };
const requiredLabels = ["Staff making calls", "Total calls", "Members reached", "Referrals", "Completed round 1", "Completed round 2", "Completed round 3"];

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "monthly-report-fields-test-"));
  chmodSync(dir, 0o700);
  process.env.DATA_DIR = dir;
  process.env.SQLITE_PATH = path.join(dir, "isolated.sqlite");
  repo = await import("./repository");
  repo.runMigrations();
  reports = await import("./executive-report");
  repo.db.exec("INSERT INTO tenants(id,name) VALUES ('a','Example Tenant'),('b','Other Tenant')");
});

beforeEach(() => {
  repo.db.exec("DELETE FROM reports; DELETE FROM monthly_metrics;");
  repo.db.prepare("INSERT INTO reports(id,tenant_id,title,reporting_year) VALUES ('report','a','Example monthly report',2025)").run();
});

afterAll(() => {
  if (repo) repo.db.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function metric(month: number, totalCalls: number | null, membersReached: number, referrals: number | null, tenant = "a") {
  // Deliberately unrelated tiny counts; no organization data or accounts.
  repo.db.prepare(`INSERT INTO monthly_metrics(
    id,tenant_id,reporting_year,reporting_month,staff_members,total_calls,members_reached,referrals,
    calls_round1,calls_round2,calls_round3,aca_yes,aca_no,head_of_household,calls_jhpp,calls_wr,notes
  ) VALUES (?,?,2025,?,2,?,?,?,2,1,2,1,1,3,2,1,'Private example note')`)
    .run(`${tenant}-${month}`, tenant, month, totalCalls, membersReached, referrals);
}

function report() {
  const value = repo.db.prepare("SELECT * FROM reports WHERE id = 'report'").get() as import("./repository").Report;
  return reports.executiveReport(value);
}

function preview(data: ReturnType<typeof report>) {
  return renderToStaticMarkup(React.createElement(ExecutivePage, { data, ...previewReportBrand(null) }));
}

function monthlyCells(html: string) {
  const row = /<tbody[^>]*>\s*<tr[^>]*>([\s\S]*?)<\/tr>/.exec(html)?.[1] ?? "";
  return [...row.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(([, value]) => value);
}

async function pdf(data: ReturnType<typeof report>, name: string) {
  const file = path.join(dir, `${name}.pdf`);
  writeFileSync(file, await reports.renderExecutivePdf(data), { mode: 0o600 });
  const result = spawnSync("pdftotext", ["-raw", file, "-"], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return { file, text: result.stdout.replace(/\s+/g, " ") };
}

describe("available monthly fields in executive reports", () => {
  it("keeps entered totals independent of rounds and destination calls in totals, rows, and preview", () => {
    metric(1, 99, 7, 8);
    metric(1, 500, 400, 300, "b");
    const data = report();
    expect(data.monthly).toHaveLength(1);
    expect(data.totals).toMatchObject({ staffMembers: 2, totalCalls: 99, membersReached: 7, totalReferrals: 8, round1: 2, round2: 1, round3: 2, callsJhpp: 2, callsWr: 1 });
    expect(data.monthly[0]).toMatchObject({ staff_members: 2, total_calls: 99, members_reached: 7, referrals: 8, calls_round1: 2, calls_round2: 1, calls_round3: 2 });
    expect(JSON.stringify(data)).not.toContain("Private example note");
    const html = preview(data);
    requiredLabels.forEach(label => expect(html).toContain(label));
    expect(monthlyCells(html)).toEqual(["2", "99", "7", "8", "2", "1", "2", "1", "1", "3", "2", "1"]);
    expect(html).not.toContain("Across all three rounds");
    expect(html).not.toContain("JHPP and WR combined");
    expect(html).toContain("5 round entries");
  });

  it("preserves explicit zero even when round and destination counts are nonzero", () => {
    metric(1, 0, 0, 0);
    const data = report();
    expect(data.totals).toMatchObject({ totalCalls: 0, membersReached: 0, totalReferrals: 0, round1: 2, round2: 1, round3: 2 });
    expect(data.monthly[0]).toMatchObject({ total_calls: 0, members_reached: 0, referrals: 0 });
    expect(monthlyCells(preview(data)).slice(0, 7)).toEqual(["2", "0", "0", "0", "2", "1", "2"]);
  });

  it("uses null-only legacy fallback per row without rewriting stored data", () => {
    metric(1, null, 0, null);
    metric(2, 99, 7, 8);
    metric(3, 0, 0, 0);
    const data = report();
    expect(data.monthly.map(m => [m.total_calls, m.members_reached, m.referrals])).toEqual([[5, 0, 3], [99, 7, 8], [0, 0, 0]]);
    expect(data.totals).toMatchObject({ totalCalls: 104, membersReached: 7, totalReferrals: 11, staffMembers: 6, round1: 6, round2: 3, round3: 6 });
    expect(repo.db.prepare("SELECT total_calls,referrals FROM monthly_metrics WHERE id = 'a-1'").get()).toEqual({ total_calls: null, referrals: null });
  });

  it("keeps all no-data totals null rather than inventing counts", () => {
    const data = report();
    expect(data.monthly).toEqual([]);
    expect(data.totals.membersReached).toBeNull();
    expect(Object.values(data.totals).every(value => value === null)).toBe(true);
  });

  it("includes all seven counts in PDF text and preserves supplemental measures", async () => {
    metric(1, 99, 7, 8);
    const { text } = await pdf(report(), "independent-counts");
    requiredLabels.forEach(label => expect(text).toContain(label));
    expect(text).toMatch(/Staff making calls\* 2 Total calls 99 Members reached 7 Referrals 8/);
    expect(text).toMatch(/01\/2025 2 99 7 8 2 1 2/);
    expect(text).toContain("Monthly supplemental detail");
    expect(text).toContain("ACA yes");
    expect(text).toContain("Heads of household");
    expect(text).toContain("JHPP calls");
    expect(text).toContain("WR calls");
  });

  it("renders explicit zero rather than derived values in PDF summary and monthly row", async () => {
    metric(1, 0, 0, 0);
    const { text } = await pdf(report(), "zero-counts");
    expect(text).toMatch(/Staff making calls\* 2 Total calls 0 Members reached 0 Referrals 0/);
    expect(text).toMatch(/01\/2025 2 0 0 0 2 1 2/);
  });
});
