import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type Database from "better-sqlite3";
import { SignJWT } from "jose";
import { createServer, type ViteDevServer, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import puppeteer, { type Browser, type Page, type HTTPRequest } from "puppeteer-core";

vi.mock("./email", () => ({ sendEmail: vi.fn(), resendMailLog: vi.fn(), emailCircuitStatus: vi.fn() }));
vi.setConfig({ testTimeout: 20000 });
const secret = "report-edit-test-secret-at-least-32-bytes";
const chromePath = process.env.CHROME_PATH || "/usr/bin/chromium";
const hasBrowser = existsSync(chromePath);
let dir: string, db: Database.Database, api: Server, origin: string, vite: ViteDevServer, browser: Browser, webOrigin: string;
const cookies: Record<string, string> = {};

async function token(id: string, role: string, tenantId: string | null) {
  return new SignJWT({ role, tenantId, csrf: "test-csrf", stage: "full", sessionVersion: 0, authProvider: "local", status: "active" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(id).setIssuer("welfare-pride-hpp").setAudience("welfare-pride-hpp-web").setExpirationTime("1h").sign(new TextEncoder().encode(secret));
}
async function request(url: string, user?: string, method = "GET", body?: object) {
  const headers: Record<string, string> = {};
  if (user) { headers.cookie = cookies[user]; headers["x-csrf-token"] = "test-csrf"; }
  if (body) headers["content-type"] = "application/json";
  return fetch(origin + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}
async function json(url: string, user?: string, method = "GET", body?: object) {
  const response = await request(url, user, method, body);
  return { response, data: await response.json() };
}
async function pageForManager(): Promise<Page> {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("response", response => { if (response.status() >= 400) void response.text().then(text => errors.push(`${response.status()} ${response.url()} ${text.slice(0, 1000)}`)).catch(() => {}); });
  await page.setCookie({ name: "wp_session", value: cookies.manager.slice("wp_session=".length), url: webOrigin });
  await page.goto(webOrigin, { waitUntil: "networkidle0" });
  try { await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some(b => b.textContent?.trim() === "Edit"), { timeout: 4000 }); }
  catch { throw new Error(`Report page failed to load: ${errors.join("; ")}; body: ${(await page.content()).slice(0, 1500)}`); }
  return page;
}
async function clickButton(page: Page, text: string) {
  await page.evaluate((t) => {
    const button = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === t);
    if (!button) throw new Error(`Missing button ${t}`);
    button.click();
  }, text);
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "report-edit-publish-test-"));
  process.env.DATA_DIR = dir;
  process.env.SQLITE_PATH = "";
  process.env.APP_SESSION_SECRET = secret;
  process.env.REPORT_RATELIMIT_MAX = "5000";
  const repo = await import("./repository");
  repo.runMigrations(); db = repo.db;
  db.exec("INSERT INTO tenants(id,name) VALUES ('a','Tenant A'),('b','Tenant B')");
  const users = [
    ["manager", "a", "manager", "active", "local"], ["admin", "a", "admin", "active", "local"],
    ["super", "a", "super_admin", "active", "local"], ["viewer", "a", "view_only", "active", "local"],
    ["viewer2", "a", "view_only", "active", "local"], ["disabled", "a", "view_only", "disabled", "local"],
    ["invited", "a", "view_only", "invited", "local"], ["sso", "a", "view_only", "active", "sso"],
    ["foreign", "b", "view_only", "active", "local"], ["foreignmanager", "b", "manager", "active", "local"],
    ["unscoped", null, "super_admin", "active", "local"],
  ] as const;
  const insert = db.prepare("INSERT INTO users(id,tenant_id,email,display_name,role,status,auth_provider,mfa_enrolled_at,mfa_secret_encrypted) VALUES (?,?,?,?,?,?,?,datetime('now'),'test-secret')");
  for (const [id, tenant, role, status, provider] of users) {
    insert.run(id, tenant, `${id}@test.example`, id, role, status, provider);
    if (status === "active" && provider === "local") cookies[id] = `wp_session=${await token(id, role, tenant)}`;
  }
  const { app } = await import("./index");
  api = await new Promise<Server>(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  origin = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  if (!hasBrowser) return;
  const harness: Plugin = {
    name: "report-browser-harness",
    resolveId(id) { return id === "virtual:report-test" ? "\0report-test" : null; },
    load(id) {
      if (id === "\0report-test") return `import React from 'react'; import {createRoot} from 'react-dom/client'; import {AuthProvider} from '/src/contexts/AuthContext.tsx'; import {ReportsPage} from '/src/pages/ReportsPage.tsx'; createRoot(document.getElementById('root')).render(React.createElement(AuthProvider, null, React.createElement(ReportsPage)));`;
    },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next();
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/@id/virtual:report-test"></script></body></html>');
    }); },
  };
  vite = await createServer({ configFile: false, root: path.resolve("client"), resolve: { alias: { "@": path.resolve("client/src") } }, plugins: [react({ fastRefresh: false }), harness], server: { host: "127.0.0.1", port: 0, hmr: false, proxy: { "/api": { target: origin } } } });
  await vite.listen();
  webOrigin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  process.env.APP_ORIGIN = webOrigin;
  browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}, 30000);

beforeEach(() => {
  db.exec("DELETE FROM report_user_assignments; DELETE FROM reports; DELETE FROM monthly_metrics; DELETE FROM audit_events;");
  db.prepare("INSERT INTO reports(id,tenant_id,title,description,reporting_year,reporting_month,layout_config,status,publish_target) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("report", "a", "Monthly report", "Previous description", 2025, 1, JSON.stringify({ widgets: ["referrals", "trend"], custom_setting: { keep: true } }), "hidden", "specific_users");
  db.prepare("INSERT INTO reports(id,tenant_id,title,status,publish_target) VALUES (?,?,?,?,?)").run("foreign-report", "b", "Foreign report", "draft", "all");
  db.prepare("INSERT INTO reports(id,tenant_id,title,status,publish_target) VALUES (?,?,?,?,?)").run("null-report", null, "Unscoped report", "draft", "all");
  db.prepare("INSERT INTO report_user_assignments(report_id,user_id) VALUES('report','viewer')").run();
  db.prepare("INSERT INTO monthly_metrics(id,tenant_id,reporting_year,reporting_month,calls_round1) VALUES('jan','a',2025,1,10),('feb','a',2025,2,20)").run();
});

afterAll(async () => {
  if (browser) await browser.close();
  if (vite) await vite.close();
  if (api) await new Promise<void>(resolve => api.close(() => resolve()));
  if (db) db.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("report editing and publish recipients", () => {
  it("returns only active local viewer candidates from the accessible report's exact tenant", async () => {
    for (const actor of ["manager", "admin", "super"]) {
      const { response, data } = await json("/api/v1/reports/report/publish-candidates", actor);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(data.users).toEqual([
        { id: "viewer", display_name: "viewer", email: "viewer@test.example", role: "view_only" },
        { id: "viewer2", display_name: "viewer2", email: "viewer2@test.example", role: "view_only" },
      ]);
    }
    expect((await request("/api/v1/admin/users", "manager")).status).toBe(403);
    expect((await request("/api/v1/reports/report/publish-candidates")).status).toBe(401);
    expect((await request("/api/v1/reports/report/publish-candidates", "viewer")).status).toBe(404);
    db.prepare("UPDATE reports SET status='published' WHERE id='report'").run();
    expect((await request("/api/v1/reports/report/publish-candidates", "viewer")).status).toBe(403);
    for (const [id, actor] of [["foreign-report", "manager"], ["report", "foreignmanager"], ["null-report", "unscoped"], ["missing", "manager"]]) {
      const response = await request(`/api/v1/reports/${id}/publish-candidates`, actor);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const actions = db.prepare("SELECT action FROM audit_events").all() as { action: string }[];
    expect(actions.some(a => a.action === "report.publish_candidates.viewed")).toBe(true);
    expect(actions.some(a => a.action === "report.publish_candidates.denied")).toBe(true);
  });

  it.skipIf(!hasBrowser)("saves a full-year edit with cleared description and original widgets and other layout settings", async () => {
    const page = await pageForManager();
    try {
      const list = await json("/api/v1/reports", "manager");
      expect(typeof list.data.reports.find((r: { id: string }) => r.id === "report").layout_config).toBe("string");
      await clickButton(page, "Edit");
      const widgets = await page.evaluate(() => Array.from(document.querySelectorAll('input[type="checkbox"]')).map(i => [(i.parentElement?.textContent || "").trim(), (i as HTMLInputElement).checked]));
      expect(widgets.filter(([, checked]) => checked).map(([label]) => label)).toEqual(["Referrals split", "Monthly trend lines"]);
      await page.select("select", "0");
      await page.$eval("textarea", el => { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!; setter.call(el, ""); el.dispatchEvent(new Event("input", { bubbles: true })); });
      await clickButton(page, "Save changes");
      await page.waitForFunction(() => document.body.textContent?.includes("Report updated"));
      const row = db.prepare("SELECT * FROM reports WHERE id = 'report'").get() as any;
      expect(row.reporting_year).toBe(2025); expect(row.reporting_month).toBeNull(); expect(row.description).toBe("");
      expect(JSON.parse(row.layout_config)).toEqual({ widgets: ["referrals", "trend"], custom_setting: { keep: true } });
      const detail = await json("/api/v1/reports/report/executive", "manager");
      expect(detail.data.period.label).toBe("2025"); expect(detail.data.monthly).toHaveLength(2); expect(detail.data.totals.totalCalls).toBe(30);
    } finally { await page.close(); }
  });

  it.skipIf(!hasBrowser)("loads and preserves existing assignments when reopening the publish modal", async () => {
    const page = await pageForManager();
    try {
      await clickButton(page, "Publish");
      await page.waitForFunction(() => document.body.textContent?.includes("viewer@test.example"));
      const state = await page.evaluate(() => {
        const labels = Array.from(document.querySelectorAll("label"));
        const selected = labels.find(l => l.textContent?.includes("viewer@test.example"))?.querySelector("input") as HTMLInputElement;
        const other = labels.find(l => l.textContent?.includes("viewer2@test.example"))?.querySelector("input") as HTMLInputElement;
        const target = labels.find(l => l.textContent?.includes("Pick exactly"))?.querySelector("input") as HTMLInputElement;
        return [selected.checked, other.checked, target.checked];
      });
      expect(state).toEqual([true, false, true]);
      await clickButton(page, "Cancel");
      await clickButton(page, "Publish");
      await page.waitForFunction(() => document.body.textContent?.includes("viewer@test.example"));
      await clickButton(page, "Publish now");
      await page.waitForFunction(() => document.body.textContent?.includes("Report published."));
      expect((await json("/api/v1/reports/report", "manager")).data.assignments).toEqual(["viewer"]);
      expect((await json("/api/v1/reports/report", "manager")).data.publish_target).toBe("specific_users");
    } finally { await page.close(); }
  });

  it.skipIf(!hasBrowser)("keeps the edit form open and reports a failed save", async () => {
    const page = await pageForManager();
    try {
      await page.setRequestInterception(true);
      page.on("request", req => {
        if (req.method() === "PATCH" && req.url().endsWith("/api/v1/admin/reports/report")) void req.respond({ status: 500, contentType: "application/json", body: '{}' });
        else void req.continue();
      });
      await clickButton(page, "Edit");
      await page.select("select", "0");
      await clickButton(page, "Save changes");
      await page.waitForFunction(() => document.querySelector("form [role=alert]")?.textContent?.includes("Save failed"));
      expect((db.prepare("SELECT reporting_month FROM reports WHERE id='report'").get() as { reporting_month: number }).reporting_month).toBe(1);
    } finally { await page.close(); }
  });

  it.skipIf(!hasBrowser)("blocks publishing while loading and ignores responses from a cancelled modal", async () => {
    const page = await pageForManager();
    let held: HTTPRequest | undefined, releaseHeld!: () => void, detailLoaded!: () => void, posts = 0;
    const intercepted = new Promise<void>(resolve => { releaseHeld = resolve; });
    const detail = new Promise<void>(resolve => { detailLoaded = resolve; });
    try {
      await page.setRequestInterception(true);
      page.on("request", req => {
        if (req.method() === "POST" && req.url().endsWith("/publish")) posts++;
        if (!held && req.url().endsWith("/api/v1/reports/report/publish-candidates")) { held = req; releaseHeld(); }
        else void req.continue();
      });
      page.on("response", response => { if (response.url().endsWith("/api/v1/reports/report")) detailLoaded(); });
      await clickButton(page, "Publish");
      await Promise.all([intercepted, detail]);
      expect(await page.evaluate(() => (Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === "Publish now") as HTMLButtonElement).disabled)).toBe(true);
      await clickButton(page, "Publish now");
      expect(posts).toBe(0);
      await clickButton(page, "Cancel");
      db.prepare("DELETE FROM report_user_assignments WHERE report_id='report'").run();
      db.prepare("INSERT INTO report_user_assignments(report_id,user_id) VALUES('report','viewer2')").run();
      await clickButton(page, "Publish");
      await page.waitForFunction(() => document.body.textContent?.includes("viewer2@test.example"));
      await held!.continue();
      await new Promise(resolve => setTimeout(resolve, 250));
      const checked = await page.evaluate(() => Array.from(document.querySelectorAll("label")).filter(l => (l.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.checked).map(l => l.textContent));
      expect(checked).toHaveLength(1); expect(checked[0]).toContain("viewer2@test.example");
      await clickButton(page, "Publish now");
      await page.waitForFunction(() => document.body.textContent?.includes("Report published."));
      expect((await json("/api/v1/reports/report", "manager")).data.assignments).toEqual(["viewer2"]);
    } finally { await page.close(); }
  });

  it.skipIf(!hasBrowser).each(["/publish-candidates", ""])('blocks publication on failed %s load and permits a safe retry', async suffix => {
    const page = await pageForManager();
    let fail = true, posts = 0;
    try {
      await page.setRequestInterception(true);
      page.on("request", req => {
        if (req.method() === "POST" && req.url().includes("/publish")) posts++;
        if (fail && req.url().endsWith(`/api/v1/reports/report${suffix}`)) { fail = false; void req.respond({ status: 500, contentType: "application/json", body: '{}' }); }
        else void req.continue();
      });
      await clickButton(page, "Publish");
      await page.waitForFunction(() => document.body.textContent?.includes("Could not load publishing settings"));
      expect(await page.evaluate(() => (Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === "Publish now") as HTMLButtonElement).disabled)).toBe(true);
      await clickButton(page, "Publish now");
      expect(posts).toBe(0);
      expect((db.prepare("SELECT status FROM reports WHERE id='report'").get() as { status: string }).status).toBe("hidden");
      await clickButton(page, "Retry");
      await page.waitForFunction(() => document.body.textContent?.includes("viewer@test.example"));
      expect(await page.evaluate(() => (Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === "Publish now") as HTMLButtonElement).disabled)).toBe(false);
    } finally { await page.close(); }
  });

  it.skipIf(!hasBrowser)("does not silently remove existing assignments whose users became unavailable", async () => {
    db.prepare("INSERT INTO report_user_assignments(report_id,user_id) VALUES('report','disabled')").run();
    const page = await pageForManager();
    try {
      await clickButton(page, "Publish");
      await page.waitForFunction(() => document.body.textContent?.includes("Previously assigned user unavailable"));
      expect(await page.evaluate(() => (Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === "Publish now") as HTMLButtonElement).disabled)).toBe(true);
      await clickButton(page, "Remove");
      expect(await page.evaluate(() => (Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === "Publish now") as HTMLButtonElement).disabled)).toBe(false);
      await clickButton(page, "Publish now");
      await page.waitForFunction(() => document.body.textContent?.includes("Report published."));
      expect((await json("/api/v1/reports/report", "manager")).data.assignments).toEqual(["viewer"]);
    } finally { await page.close(); }
  });
});
