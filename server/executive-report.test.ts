import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutivePage, previewReportBrand } from "../client/src/components/ExecutiveReportPreview";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Server } from "node:http";
import { SignJWT } from "jose";
import type Database from "better-sqlite3";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("./email", () => ({ sendEmail: mocks.send, resendMailLog: vi.fn(), emailCircuitStatus: vi.fn() }));
const secret = "executive-integration-secret-only-123456789";
let dir: string, server: Server, origin: string, db: Database.Database;
const cookies: Record<string, string> = {};
let repo: typeof import("./repository");
let reports: typeof import("./executive-report");

async function token(id: string, role: string, tenantId: string | null) {
  return new SignJWT({ role, tenantId, csrf: "csrf-test", stage: "full", sessionVersion: 0, authProvider: "local", status: "active" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(id).setIssuer("welfare-pride-hpp").setAudience("welfare-pride-hpp-web").setExpirationTime("1h").sign(new TextEncoder().encode(secret));
}
async function request(url: string, who?: string, method = "GET", body?: object, csrf = true) {
  const headers: Record<string, string> = {};
  if (who) { headers.cookie = cookies[who]; if (csrf) headers["x-csrf-token"] = "csrf-test"; }
  if (body) headers["content-type"] = "application/json";
  return fetch(origin + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}
async function json(url: string, who?: string, method = "GET", body?: object) { const r = await request(url, who, method, body); return { r, data: await r.json() }; }

function pdfPages(pdf: string) {
  const result = spawnSync("pdftotext", ["-raw", pdf, "-"], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const pages = result.stdout.split("\f");
  if (!pages[pages.length - 1].trim()) pages.pop();
  return pages;
}
function pdfStreams(bytes: Buffer) {
  const raw = bytes.toString("latin1");
  const streams: string[] = [];
  for (const match of raw.matchAll(/stream\r?\n/g)) {
    const start = match.index! + match[0].length, end = raw.indexOf("endstream", start);
    try { streams.push(inflateSync(bytes.subarray(start, end)).toString("latin1")); } catch { /* Uncompressed or image streams are irrelevant. */ }
  }
  return streams.join("\n");
}
function bodyText(page: string) {
  return page.replace(/HEALTH PLAN OUTREACH/g, "")
    .replace(/Welfare Pride\s*\|\s*Executive report\s*Page\s*\d+\s*of\s*\d+\s*\|\s*Typeface: Roboto/g, "")
    .replace(/Welfare Pride/g, "");
}
function assertPageFurniture(pages: string[]) {
  pages.forEach((page, i) => {
    expect(page).toContain("HEALTH PLAN OUTREACH");
    expect(page).toContain(`Page ${i + 1} of ${pages.length}`);
    // A page containing only a repeated header and footer is still a blank page.
    expect(bodyText(page).trim().length).toBeGreaterThan(0);
  });
}
function assertWordsDoNotOverlap(pdf: string) {
  const result = spawnSync("pdftotext", ["-bbox", pdf, "-"], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const pages = [...result.stdout.matchAll(/<page\b[^>]*>([\s\S]*?)<\/page>/g)];
  expect(pages.length).toBeGreaterThan(0);
  for (const [, page] of pages) {
    const words = [...page.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
      .map(([, x1, y1, x2, y2, text]) => ({ x1: +x1, y1: +y1, x2: +x2, y2: +y2, text }));
    for (const [i, a] of words.entries()) {
      expect(a.x1, a.text).toBeGreaterThanOrEqual(40);
      expect(a.x2, a.text).toBeLessThanOrEqual(556);
      expect(a.y1, a.text).toBeGreaterThanOrEqual(0);
      expect(a.y2, a.text).toBeLessThanOrEqual(842);
      for (const b of words.slice(i + 1)) {
        const xOverlap = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
        const yOverlap = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
        if (xOverlap > 0.5 && yOverlap > 0.5) throw new Error(`overlap: ${a.text} / ${b.text}`);
      }
    }
  }
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "executive-report-test-"));
  process.env.DATA_DIR = dir;
  process.env.SQLITE_PATH = "";
  process.env.APP_SESSION_SECRET = secret;
  process.env.GLOBAL_EMAIL_BCC = "";
  process.env.REPORT_RATELIMIT_MAX = "1000";
  repo = await import("./repository");
  reports = await import("./executive-report");
  repo.runMigrations();
  db = repo.db;
  db.exec("INSERT INTO tenants(id,name) VALUES ('a','Tenant A'),('b','Tenant B')");
  const users = [
    ["editor", "a", "manager", "active", "local"], ["viewer", "a", "view_only", "active", "local"],
    ["other", "a", "view_only", "active", "local"], ["disabled", "a", "view_only", "disabled", "local"],
    ["invited", "a", "view_only", "invited", "local"], ["sso", "a", "view_only", "active", "sso"],
    ["foreign", "b", "manager", "active", "local"], ["super", "a", "super_admin", "active", "local"], ["nulluser", null, "super_admin", "active", "local"],
  ] as const;
  const insert = db.prepare("INSERT INTO users(id,tenant_id,email,display_name,role,status,auth_provider,mfa_enrolled_at,mfa_secret_encrypted) VALUES (?,?,?,?,?,?,?,datetime('now'),'test-secret')");
  for (const [id, tenant, role, status, provider] of users) {
    insert.run(id, tenant, `${id}@test.example`, id, role, status, provider);
    if (status === "active" && provider === "local") cookies[id] = `wp_session=${await token(id, role, tenant)}`;
  }
  const metric = db.prepare("INSERT INTO monthly_metrics(id,tenant_id,reporting_year,reporting_month,calls_round1,calls_round2,calls_round3,aca_yes,aca_no,head_of_household,staff_members,calls_jhpp,calls_wr) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  metric.run("jan", "a", 2025, 1, 10, 20, 30, 3, 1, 6, 2, 4, 5);
  metric.run("feb", "a", 2025, 2, 1, 2, 3, 1, 3, 7, 3, 8, 9);
  metric.run("next", "a", 2026, 1, 100, 200, 300, 30, 10, 60, 20, 40, 50);
  metric.run("bad", "b", 2025, 1, 9999, 0, 0, 0, 0, 0, 0, 0, 0);
  metric.run("unscoped", null, 2025, 1, 8888, 0, 0, 0, 0, 0, 0, 0, 0);
  const ins = db.prepare("INSERT INTO reports(id,tenant_id,title,reporting_year,reporting_month,status,publish_target) VALUES (?,?,?,?,?,?,?)");
  ins.run("year", "a", "Year report", 2025, null, "published", "specific_users");
  ins.run("jan-report", "a", "January report", 2025, 1, "published", "all");
  ins.run("all", "a", "All periods", null, null, "published", "all");
  ins.run("all-jan", "a", "Every January", null, 1, "published", "all");
  ins.run("empty", "a", "Empty period", 2024, null, "published", "all");
  ins.run("draft", "a", "Draft report", 2025, null, "draft", "all");
  ins.run("hidden", "a", "Hidden report", 2025, null, "hidden", "all");
  ins.run("foreign-report", "b", "Foreign report", 2025, null, "published", "all");
  ins.run("null-report", null, "Unscoped report", null, null, "published", "all");
  db.prepare("INSERT INTO report_user_assignments(report_id,user_id) VALUES('year','viewer')").run();
  const { app } = await import("./index");
  server = await new Promise<Server>(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 30000);
beforeEach(() => { mocks.send.mockReset(); mocks.send.mockResolvedValue({ ok: true, provider: "mock", logId: "log" }); });
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); if (db) db.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("executive report branding", () => {
  it("normalizes brand fields and guarantees AA table contrast for light and dark backgrounds", () => {
    const configured = { company_name: "Acme Health", primary_color: "#123456", secondary_color: "#ed8902", logo_url: "/assets/branding/welfare-pride-icon.png" };
    expect(reports.reportBrand(configured)).toEqual({ company: "Acme Health", primary: "#123456", secondary: "#ed8902", logo: configured.logo_url });
    expect(previewReportBrand(configured)).toEqual({ company: "Acme Health", primary: "#123456", secondary: "#ed8902", logo: configured.logo_url });
    for (const invalid of ["#123", "#12345678", "red", "#12345g", "#123456;", "#123456\n", " #123456", ""]) {
      expect(reports.reportBrand({ primary_color: invalid, secondary_color: invalid, company_name: "  " })).toMatchObject({ company: "Welfare Pride", primary: "#5A92C9", secondary: "#D58240" });
      expect(previewReportBrand({ primary_color: invalid, secondary_color: invalid, company_name: "  " })).toMatchObject({ company: "Welfare Pride", primary: "#5A92C9", secondary: "#D58240" });
    }
    const ratio = (background: string, foreground: string) => {
      const rgb = [1, 3, 5].map(i => parseInt(background.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
      const l = .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
      return foreground === "#000000" ? (l + .05) / .05 : 1.05 / (l + .05);
    };
    for (const background of ["#000000", "#FFFFFF", "#777777", "#5A92C9", "#123456", "#00ff00", "#ff00ff", "#ffff00"]) expect(ratio(background, reports.reportContrastText(background))).toBeGreaterThanOrEqual(4.5);
    expect(reports.reportContrastText("#000000")).toBe("#FFFFFF");
    expect(reports.reportContrastText("#FFFFFF")).toBe("#000000");
  });
  it("only loads local matching PNG/JPEG files, rejects paths, symlinks, untrusted URLs and unsupported images", () => {
    const logos = mkdtempSync(path.join(os.tmpdir(), "report-logos-"));
    try {
      const original = path.resolve("branding/welfare-pride-main-logo.png");
      copyFileSync(original, path.join(logos, "welfare-pride-main-logo.png"));
      copyFileSync(path.resolve("branding/welfare-pride-icon.png"), path.join(logos, "custom.logo.png"));
      copyFileSync(path.resolve("branding/welfare-pride-icon.jpg"), path.join(logos, "custom.jpg"));
      writeFileSync(path.join(logos, "fake.png"), "not a PNG");
      symlinkSync(path.resolve("branding/welfare-pride-icon.png"), path.join(logos, "link.png"));
      const fallback = readFileSync(original);
      expect(reports.loadReportLogo("/assets/branding/welfare-pride-main-logo.webp", logos)).toEqual(fallback);
      expect(reports.loadReportLogo("/assets/branding/custom.logo.png", logos)).toEqual(readFileSync(path.join(logos, "custom.logo.png")));
      expect(reports.loadReportLogo("/assets/branding/custom.jpg", logos)).toEqual(readFileSync(path.join(logos, "custom.jpg")));
      for (const input of [null, "https://example.com/custom.png", "http://127.0.0.1/private", "//example.com/custom.png", "/assets/branding/../secret.png", "/assets/branding/%2e%2e/secret.png", "/assets/branding/foo/secret.png", "/assets/branding/..%2fsecret.png", "/assets/branding/custom.webp", "/assets/branding/custom.jpg?x=1", "/assets/branding/custom.jpg\n", "/assets/branding/link.png", "/assets/branding/fake.png", "/assets/branding/missing.png"]) {
        expect(reports.loadReportLogo(input, logos).equals(fallback), String(input)).toBe(true);
        if (input !== "/assets/branding/link.png" && input !== "/assets/branding/fake.png" && input !== "/assets/branding/missing.png") expect(previewReportBrand({ logo_url: input }).logo).toBe("/assets/branding/welfare-pride-main-logo.webp");
      }
    } finally { rmSync(logos, { recursive: true, force: true }); }
  });
  it("uses saved name and colors in preview and PDF without exposing other configuration", async () => {
    db.prepare("UPDATE brand_config SET company_name = ?, primary_color = ?, secondary_color = ?, logo_url = ?, email_header_text = ? WHERE id = 1").run("Acme Health", "#123456", "#ED8902", "/assets/branding/welfare-pride-icon.jpg", "PRIVATE HEADER VALUE");
    try {
      const data = (await json("/api/v1/reports/year/executive", "viewer")).data;
      expect(JSON.stringify(data)).not.toContain("PRIVATE HEADER VALUE");
      const brand = previewReportBrand(repo.getBrandConfig());
      const html = renderToStaticMarkup(React.createElement(ExecutivePage, { data, ...brand }));
      expect(html).toContain("Acme Health"); expect(html).toContain("#123456"); expect(html).toContain("#ED8902");
      expect(html).toMatch(/<thead style="background-color:#123456;color:#FFFFFF">/);
      const lightHtml = renderToStaticMarkup(React.createElement(ExecutivePage, { data, ...brand, primary: "#FFFFFF" }));
      expect(lightHtml).toMatch(/<thead style="background-color:#FFFFFF;color:#000000">/);
      expect(html).toContain("Typeface: Roboto (embedded in PDF)");
      expect(html).toContain("Generated from current metric data");
      const response = await request("/api/v1/reports/year/pdf", "viewer");
      expect(response.status).toBe(200);
      const pdf = path.join(dir, "custom-brand.pdf"); const pdfBytes = Buffer.from(await response.arrayBuffer()); writeFileSync(pdf, pdfBytes);
      const content = pdfStreams(pdfBytes);
      // The table's dark primary fill is immediately followed by white text.
      expect(content).toMatch(/0\.07058823529411765 0\.20392156862745098 0\.33725490196078434 scn\s+f\s+\/DeviceRGB cs\s+1 1 1 scn/);
      const text = spawnSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8" }).stdout;
      expect((text.match(/Acme Health/g) || []).length).toBeGreaterThanOrEqual(2);
      expect(text).toContain("Typeface: Roboto"); expect(text).toContain("Generated from current metric data"); expect(text).not.toContain("PRIVATE HEADER VALUE");
      expect(spawnSync("pdfinfo", [pdf], { encoding: "utf8" }).stdout).toContain("Acme Health");
      expect(spawnSync("pdfimages", ["-list", pdf], { encoding: "utf8" }).stdout).toMatch(/1378\s+1379/);
      const raster = spawnSync("pdftoppm", ["-r", "72", "-singlefile", pdf], { maxBuffer: 10_000_000 });
      expect(raster.status).toBe(0);
      expect(raster.stdout.includes(Buffer.from([0x12, 0x34, 0x56]))).toBe(true);
      expect(raster.stdout.includes(Buffer.from([0xed, 0x89, 0x02]))).toBe(true);
      assertWordsDoNotOverlap(pdf);
      db.prepare("UPDATE brand_config SET company_name = ? WHERE id = 1").run("W".repeat(120));
      const longNameResponse = await request("/api/v1/reports/year/pdf", "viewer"); expect(longNameResponse.status).toBe(200);
      const longNamePdf = path.join(dir, "long-name.pdf"); writeFileSync(longNamePdf, Buffer.from(await longNameResponse.arrayBuffer()));
      expect(spawnSync("pdftotext", ["-raw", longNamePdf, "-"], { encoding: "utf8" }).stdout).toContain("W".repeat(120));
      assertWordsDoNotOverlap(longNamePdf);
      db.prepare("UPDATE brand_config SET logo_url = 'https://127.0.0.1/logo.png', primary_color = '#abc', secondary_color = '#invalid' WHERE id = 1").run();
      const fallback = await request("/api/v1/reports/year/pdf", "viewer"); expect(fallback.status).toBe(200);
      const fallbackPdf = path.join(dir, "fallback-brand.pdf"); const fallbackBytes = Buffer.from(await fallback.arrayBuffer()); writeFileSync(fallbackPdf, fallbackBytes);
      expect(pdfStreams(fallbackBytes)).toMatch(/0\.35294117647058826 0\.5725490196078431 0\.788235294117647 scn\s+f\s+\/DeviceRGB cs\s+0 0 0 scn/);
      expect(spawnSync("pdfimages", ["-list", fallbackPdf], { encoding: "utf8" }).stdout).toMatch(/2048\s+1000/);
      const fallbackRaster = spawnSync("pdftoppm", ["-r", "72", "-singlefile", fallbackPdf], { maxBuffer: 10_000_000 });
      expect(fallbackRaster.stdout.includes(Buffer.from([0x5a, 0x92, 0xc9]))).toBe(true);
      expect(fallbackRaster.stdout.includes(Buffer.from([0xd5, 0x82, 0x40]))).toBe(true);
    } finally {
      db.prepare("UPDATE brand_config SET company_name = 'Welfare Pride', primary_color = '#5A92C9', secondary_color = '#D58240', logo_url = '/assets/branding/welfare-pride-main-logo.webp', email_header_text = 'Welfare Pride · Secure Reporting Portal' WHERE id = 1").run();
    }
  });
});

describe("executive report security and reporting", () => {
  it("scopes by tenant, exact year/month, and returns null instead of invented missing metrics", async () => {
    const { r, data } = await json("/api/v1/reports/year/executive", "viewer");
    expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe("no-store");
    expect(data.period.label).toBe("2025"); expect(data.monthly).toHaveLength(2);
    expect(data.totals).toEqual({ totalCalls: 66, round1: 11, round2: 22, round3: 33, acaYes: 4, acaNo: 4, acaRate: 50, headOfHousehold: 13, staffMembers: 5, callsJhpp: 12, callsWr: 14, totalReferrals: 26 });
    const jan = (await json("/api/v1/reports/jan-report/executive", "viewer")).data;
    expect(jan.period.label).toBe("January 2025"); expect(jan.monthly).toHaveLength(1); expect(jan.totals.totalCalls).toBe(60);
    const all = (await json("/api/v1/reports/all/executive", "viewer")).data;
    expect(all.period.label).toBe("All periods"); expect(all.monthly).toHaveLength(3); expect(all.totals.totalCalls).toBe(666);
    const allJan = (await json("/api/v1/reports/all-jan/executive", "viewer")).data;
    expect(allJan.period.label).toBe("January · all years"); expect(allJan.monthly).toHaveLength(2); expect(allJan.totals.totalCalls).toBe(660);
    const empty = (await json("/api/v1/reports/empty/executive", "viewer")).data;
    expect(empty.monthly).toEqual([]); expect(Object.values(empty.totals).every(v => v === null)).toBe(true);
    db.prepare("INSERT INTO monthly_metrics(id,tenant_id,reporting_year,reporting_month) VALUES('zero','a',2024,1)").run();
    const zero = (await json("/api/v1/reports/empty/executive", "viewer")).data;
    expect(zero.totals.totalCalls).toBe(0); expect(zero.totals.acaRate).toBeNull();
    db.prepare("DELETE FROM monthly_metrics WHERE id = 'zero'").run();
  });
  it("denies unauthenticated, cross-tenant, unassigned, hidden and unscoped access consistently", async () => {
    expect((await request("/api/v1/reports/year/executive")).status).toBe(401);
    for (const suffix of ["", "/executive", "/pdf", "/export", "/recipients"]) {
      expect((await request(`/api/v1/reports/year${suffix}`, "other")).status).toBe(404);
      expect((await request(`/api/v1/reports/foreign-report${suffix}`, "editor")).status).toBe(404);
      expect((await request(`/api/v1/reports/hidden${suffix}`, "viewer")).status).toBe(404);
      expect((await request(`/api/v1/reports/null-report${suffix}`, "nulluser")).status).toBe(404);
    }
    expect((await request("/api/v1/reports/draft/executive", "viewer")).status).toBe(404);
    expect((await request("/api/v1/reports/year/recipients", "viewer")).status).toBe(403);
    const { data } = await json("/api/v1/reports", "other");
    expect(data.reports.map((r: { id: string }) => r.id)).not.toContain("year");
    expect(data.reports.map((r: { id: string }) => r.id)).not.toContain("foreign-report");
    for (const route of ["/api/v1/metrics", "/api/v1/metrics/years", "/api/v1/metrics/2025/1", "/api/v1/metrics/export", "/api/v1/dashboard/summary"]) expect((await request(route, "viewer")).status).toBe(403);
    for (const action of ["publish", "hide"]) expect((await request(`/api/v1/admin/reports/foreign-report/${action}`, "editor", "POST", action === "publish" ? { target: "all" } : {})).status).toBe(404);
    expect((await request("/api/v1/admin/reports/foreign-report", "editor", "PATCH", { title: "change" })).status).toBe(404);
    expect((await request("/api/v1/admin/reports/year/publish", "editor", "POST", { target: "specific_users", userIds: ["foreign"] })).status).toBe(400);
  });
  it("produces real PDF bytes using embedded brand assets and clearly identifies absent data", async () => {
    for (const id of ["year", "empty"]) {
      const response = await request(`/api/v1/reports/${id}/pdf`, "viewer");
      expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("application/pdf");
      const bytes = Buffer.from(await response.arrayBuffer()); expect(bytes.subarray(0, 5).toString()).toBe("%PDF-"); expect(bytes.length).toBeGreaterThan(5000);
      const pdf = path.join(dir, `${id}.pdf`); writeFileSync(pdf, bytes);
      expect(spawnSync("pdfinfo", [pdf], { encoding: "utf8" }).stdout).toMatch(/Pages:\s+1\b/);
      expect(spawnSync("pdffonts", [pdf], { encoding: "utf8" }).stdout).toMatch(/Roboto/);
      const txt = spawnSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8" });
      expect(txt.status).toBe(0); expect(txt.stdout).toContain("Executive report");
      expect(txt.stdout).toContain("Page 1 of 1");
      expect(txt.stdout).toMatch(/Generated:\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s+\(UTC\)/);
      expect(txt.stdout).toContain("Generated from current metric data");
      expect(txt.stdout.replace(/\s+/g, " ")).toContain("regenerate this report to see the latest data");
      assertPageFurniture(pdfPages(pdf));
      assertWordsDoNotOverlap(pdf);
      if (id === "year") { expect(txt.stdout).toContain("Staff entries are summed across months, not unique people"); expect(txt.stdout).toContain("01/2025"); expect(txt.stdout).toContain("02/2025"); }
      else expect(txt.stdout).toContain("No metric data is available");
    }
  });
  it("renders complete long user-entered title and 2000-character description across pages without overlaps", async () => {
    const title = "TitleStart" + "W".repeat(162) + "EndTitle"; // 180 characters, including an unbroken word
    const paragraphs = Array.from({ length: 90 }, (_, i) => `Entry${String(i).padStart(3, "0")} distinctive regional detail`);
    paragraphs[12] = "UnbrokenStart" + "q".repeat(180) + "UnbrokenEnd";
    const end = "\nEndingMarkerOmega";
    const description = paragraphs.join("\n").slice(0, 2000 - end.length) + end;
    expect(title).toHaveLength(180); expect(description).toHaveLength(2000);
    db.prepare("UPDATE reports SET title = ?, description = ? WHERE id = 'year'").run(title, description);
    try {
      const response = await request("/api/v1/reports/year/pdf", "viewer");
      expect(response.status).toBe(200);
      const pdf = path.join(dir, "long-description.pdf"); writeFileSync(pdf, Buffer.from(await response.arrayBuffer()));
      const pages = pdfPages(pdf);
      expect(pages.length).toBeGreaterThanOrEqual(2);
      assertPageFurniture(pages);
      const body = pages.map(bodyText).join("").replace(/\s/g, "");
      expect(body).toContain(title.replace(/\s/g, ""));
      expect(body).toContain(description.replace(/\s/g, ""));
      for (const metric of ["Total calls", "Round 1", "Round 2", "Round 3", "ACA yes", "ACA no", "Heads of household", "Staff entries*", "JHPP calls", "WR calls"]) {
        expect(body).toContain(metric.replace(/\s/g, ""));
      }
      expect(body).toContain("Monthlydetail");
      expect(body).toContain("01/2025"); expect(body).toContain("02/2025");
      assertWordsDoNotOverlap(pdf);
    } finally {
      db.prepare("UPDATE reports SET title = 'Year report', description = NULL WHERE id = 'year'").run();
    }
  });
  it("paginates long monthly tables without blank footer pages", async () => {
    const insert = db.prepare("INSERT INTO monthly_metrics(id,tenant_id,reporting_year,reporting_month,calls_round1,calls_round2,calls_round3,aca_yes,aca_no,head_of_household,staff_members,calls_jhpp,calls_wr) VALUES (?,?,?,?,1,2,3,1,1,1,1,1,1)");
    for (let i = 0; i < 25; i++) insert.run(`long-${i}`, "a", 2030 + Math.floor(i / 12), 1 + i % 12);
    const response = await request("/api/v1/reports/all/pdf", "viewer");
    expect(response.status).toBe(200);
    const pdf = path.join(dir, "long.pdf"); writeFileSync(pdf, Buffer.from(await response.arrayBuffer()));
    expect(spawnSync("pdfinfo", [pdf], { encoding: "utf8" }).stdout).toMatch(/Pages:\s+2\b/);
    const text = spawnSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8" }).stdout;
    expect(text).toContain("01/2032"); expect(text).toContain("Page 1 of 2"); expect(text).toContain("Page 2 of 2");
    const pages = pdfPages(pdf); assertPageFurniture(pages);
    expect(pages.every(page => page.includes("Period") && page.includes("Household"))).toBe(true);
    assertWordsDoNotOverlap(pdf);
    db.prepare("DELETE FROM monthly_metrics WHERE id LIKE 'long-%'").run();
  });
  it("only emails authorized active users; blocks BCC, CSRF and arbitrary recipients", async () => {
    const { data: recipients } = await json("/api/v1/reports/year/recipients", "editor");
    expect(recipients.users.map((u: { id: string }) => u.id).sort()).toEqual(["editor", "viewer"]);
    expect((await request("/api/v1/reports/year/email", "editor", "POST", { recipientUserId: "viewer" }, false)).status).toBe(403);
    for (const id of ["other", "foreign", "disabled", "invited", "sso", "super"]) expect((await request("/api/v1/reports/year/email", "editor", "POST", { recipientUserId: id })).status).toBe(404);
    expect((await request("/api/v1/reports/draft/email", "editor", "POST", { recipientUserId: "viewer" })).status).toBe(404);
    expect((await request("/api/v1/reports/year/email", "viewer", "POST", { recipientUserId: "viewer" })).status).toBe(403);
    db.prepare("UPDATE email_config SET global_bcc = 'archive@test.example' WHERE id = 1").run();
    expect((await request("/api/v1/reports/year/email", "editor", "POST", { recipientUserId: "viewer" })).status).toBe(409);
    expect(mocks.send).not.toHaveBeenCalled();
    db.prepare("UPDATE email_config SET global_bcc = NULL WHERE id = 1").run();
    process.env.GLOBAL_EMAIL_BCC = "archive@test.example";
    expect((await request("/api/v1/reports/year/email", "editor", "POST", { recipientUserId: "viewer" })).status).toBe(409);
    process.env.GLOBAL_EMAIL_BCC = "";
    const result = await json("/api/v1/reports/year/email", "editor", "POST", { recipientUserId: "viewer" });
    expect(result.r.status).toBe(200); expect(result.data).toEqual({ ok: true, status: "accepted", provider: "mock" });
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send.mock.calls[0][0]).toMatchObject({ to: "viewer@test.example", requireNoBcc: true, attachments: [{ filename: "welfare-pride-executive-report.pdf", contentType: "application/pdf" }] });
    expect(mocks.send.mock.calls[0][0].attachments[0].content.subarray(0, 5).toString()).toBe("%PDF-");
    mocks.send.mockResolvedValueOnce({ ok: false, provider: "mock", logId: "failed", error: "secret provider detail" });
    const failed = await json("/api/v1/reports/year/email", "editor", "POST", { recipientUserId: "viewer" });
    expect(failed.r.status).toBe(502); expect(JSON.stringify(failed.data)).not.toContain("secret provider detail");
    mocks.send.mockResolvedValueOnce({ ok: false, provider: "mock", status: "unknown", logId: "unknown" });
    const unknown = await json("/api/v1/reports/year/email", "editor", "POST", { recipientUserId: "viewer" });
    expect(unknown.r.status).toBe(502); expect(unknown.data).toEqual({ ok: false, status: "unknown", error: "REPORT_EMAIL_UNKNOWN" });
    mocks.send.mockResolvedValueOnce({ ok: false, provider: "none", status: "failed", error: "Email engine is disabled", logId: "disabled" });
    const disabled = await json("/api/v1/reports/year/email", "editor", "POST", { recipientUserId: "viewer" });
    expect(disabled.r.status).toBe(409); expect(disabled.data.error).toBe("REPORT_EMAIL_DISABLED");
    mocks.send.mockResolvedValueOnce({ ok: true, provider: "simulation", status: "simulated", logId: "simulation" });
    const simulated = await json("/api/v1/reports/year/email", "editor", "POST", { recipientUserId: "viewer" });
    expect(simulated.data).toEqual({ ok: true, status: "simulated", provider: "simulation" });
    const actions = (db.prepare("SELECT action FROM audit_events").all() as { action: string }[]).map(a => a.action);
    expect(actions).toContain("report.email.accepted"); expect(actions).toContain("report.email.unknown"); expect(actions).toContain("report.email.denied");
  });
  it("validates email configuration fields and never returns stored credentials", async () => {
    expect((await request("/api/v1/admin/email", "editor", "PUT", { enabled: 1 })).status).toBe(403);
    expect((await request("/api/v1/admin/email", "super", "PUT", { enabled: 2 })).status).toBe(400);
    expect((await request("/api/v1/admin/email", "super", "PUT", { "enabled = 1 --": 1 })).status).toBe(400);
    expect((await request("/api/v1/admin/email", "super", "PUT", { graph_tenant_id: "evil/path?query" })).status).toBe(400);
    const saved = await json("/api/v1/admin/email", "super", "PUT", { smtp_pass: "temporary-test-secret", enabled: 1 });
    expect(saved.r.status).toBe(200); expect(saved.data.smtp_pass).toBe("__configured__");
    expect(JSON.stringify(saved.data)).not.toContain("temporary-test-secret");
    const untouched = await json("/api/v1/admin/email", "super", "PUT", { smtp_pass: "__configured__" });
    expect(untouched.data.smtp_pass).toBe("__configured__");
    expect(repo.getEmailConfig().smtp_pass).toBe("temporary-test-secret");
    await request("/api/v1/admin/email", "super", "PUT", { smtp_pass: null, enabled: 0 });
  });
});
