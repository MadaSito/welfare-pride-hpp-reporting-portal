import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

// Browser-only mock API: never imports the repository or opens real/default data.
const chromePath = process.env.CHROME_PATH || "/usr/bin/chromium";
const hasBrowser = existsSync(chromePath);
let dir: string, vite: ViteDevServer, browser: Browser, origin: string;
const testUser = { id: "installed-admin", email: "install@example.org", display_name: "Installed administrator", role: "super_admin", status: "active", auth_provider: "local" };
const manualSecret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const codes = Array.from({ length: 8 }, (_, n) => `ABCD-${String(n + 1).padStart(4, "0")}`);
const temporaryPassword = "browser-fixture-temporary-password";
const newPassphrase = "a long unique lowercase passphrase";

beforeAll(async () => {
  if (!hasBrowser) return;
  dir = mkdtempSync(path.join(os.tmpdir(), "wp-install-login-ui-"));
  const harness: Plugin = {
    name: "install-login-ui-harness",
    resolveId(id) { return id === "virtual:install-login-ui" ? "\0install-login-ui" : null; },
    load(id) {
      if (id !== "\0install-login-ui") return;
      return `import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {AuthProvider, useAuth} from '/src/contexts/AuthContext.tsx';
        import {BrandingProvider} from '/src/contexts/BrandingContext.tsx';
        import {LoginPage} from '/src/pages/LoginPage.tsx';
        import QRCode from 'qrcode';
        import '/src/index.css';
        if (new URLSearchParams(location.search).has('qrFail')) QRCode.toCanvas = (_canvas, _uri, _opts, callback) => callback(new Error('Test QR failure'));
        function Shell() {
          const auth = useAuth();
          if (auth.loading) return React.createElement('p', null, 'Loading');
          return React.createElement(React.Fragment, null,
            React.createElement('output', {'data-testid': 'auth-stage', hidden: true}, auth.stage),
            React.createElement('button', {'data-testid': 'refresh-session', style: {position:'absolute', width:1, height:1, overflow:'hidden'}, onClick: () => auth.refresh()}, 'Test session refresh'),
            auth.stage === 'full' ? React.createElement('h1', null, 'Portal ready') : React.createElement(LoginPage));
        }
        createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(BrandingProvider, null, React.createElement(AuthProvider, null, React.createElement(Shell)))));`;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/") return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:install-login-ui"></script></body></html>');
      });
    },
  };
  vite = await createServer({
    configFile: false, root: path.resolve("client"), cacheDir: path.join(dir, "vite-cache"),
    resolve: { alias: { "@": path.resolve("client/src") } },
    plugins: [react({ fastRefresh: false }), tailwindcss(), harness],
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await vite.listen();
  origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  browser = await puppeteer.launch({ executablePath: chromePath, headless: true, userDataDir: path.join(dir, "chrome-profile"), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}, 30000);

afterAll(async () => {
  if (browser) await browser.close();
  if (vite) await vite.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

type Options = { nextStage?: "full" | "password_change"; initialStage?: "anonymous" | "mfa_enroll" | "password_change" | "mfa_verify"; qrFail?: boolean; failEnrollment?: boolean; failVerification?: boolean; passwordError?: string };
async function fixture(options: Options = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(4000);
  page.setDefaultNavigationTimeout(15000);
  await page.setViewport({ width: 320, height: 740 });
  const state = {
    stage: options.initialStage || "anonymous", enrollRequests: 0, verifyRequests: 0, passwordRequests: 0,
    passwordPayloadValid: false, loginPayloadValid: false, csrfGeneration: 0, console: [] as string[], urls: [] as string[],
    passwordError: options.passwordError,
  };
  page.on("console", message => state.console.push(message.text()));
  page.on("pageerror", () => state.console.push("browser-page-error"));
  await page.setRequestInterception(true);
  page.on("request", req => {
    state.urls.push(req.url());
    const url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) { void req.continue(); return; }
    let status = 200;
    let data: Record<string, unknown> = {};
    const session = () => ({ stage: state.stage, userId: testUser.id, csrf: `csrf-${++state.csrfGeneration}`, ...(state.stage === "full" ? { user: testUser } : {}) });
    switch (url.pathname) {
      case "/api/v1/branding": data = { company_name: "Welfare Pride", tagline: "Outreach Reporting Dashboard Portal", icon_url: "/assets/branding/welfare-pride-icon.png" }; break;
      case "/api/v1/auth/setup/status": data = { setupNeeded: false }; break;
      case "/api/v1/auth/session": data = session(); break;
      case "/api/v1/auth/login": {
        const payload = JSON.parse(req.postData() || "{}");
        state.loginPayloadValid = payload.email === testUser.email && payload.password === temporaryPassword;
        state.stage = "mfa_enroll"; data = session(); break;
      }
      case "/api/v1/auth/mfa/enroll":
        state.enrollRequests++;
        if (options.failEnrollment && state.enrollRequests === 1) { status = 503; data = { error: "UNAVAILABLE" }; }
        else data = { uri: `otpauth://totp/Welfare%20Pride:install%40example.org?secret=${manualSecret}&issuer=Welfare%20Pride`, manualSecret };
        break;
      case "/api/v1/auth/mfa/verify":
        state.verifyRequests++;
        if (options.failVerification && state.verifyRequests === 1) { void req.abort("failed"); return; }
        state.stage = options.nextStage || "password_change";
        data = { ok: true, ...session(), ...(options.initialStage === "mfa_verify" ? {} : { recoveryCodes: codes }) };
        break;
      case "/api/v1/auth/password": {
        state.passwordRequests++;
        const payload = JSON.parse(req.postData() || "{}");
        state.passwordPayloadValid = payload.currentPassword === temporaryPassword && payload.newPassword === newPassphrase;
        if (state.passwordError) { status = 400; data = { error: state.passwordError }; }
        else { state.stage = "full"; data = { ok: true, ...session() }; }
        break;
      }
      case "/api/v1/auth/logout": state.stage = "anonymous"; data = { ok: true }; break;
      default: status = 404; data = { error: "UNMOCKED_API" };
    }
    void req.respond({ status, contentType: "application/json", body: JSON.stringify(data), headers: { "cache-control": "no-store" } });
  });
  await page.goto(origin + (options.qrFail ? "/?qrFail=1" : "/"), { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="auth-stage"]', { visible: false, timeout: 15000 });
  return { page, state };
}
async function click(page: Page, text: string) {
  await page.evaluate(t => {
    const button = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === t);
    if (!button) throw new Error(`Missing button: ${t}`);
    button.click();
  }, text);
}
async function fill(page: Page, selector: string, value: string) {
  await page.$eval(selector, (el, input) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, input);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}
async function waitStage(page: Page, stage: string) {
  await page.waitForFunction(s => document.querySelector('[data-testid="auth-stage"]')?.textContent === s, {}, stage);
}
async function assertNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
async function assertPrivate(page: Page, state: Awaited<ReturnType<typeof fixture>>["state"]) {
  const sensitive = [temporaryPassword, newPassphrase, manualSecret, ...codes];
  expect(state.console.some(line => sensitive.some(secret => line.includes(secret)))).toBe(false);
  expect(state.urls.some(url => sensitive.some(secret => url.includes(secret)))).toBe(false);
  expect(state.console.includes("browser-page-error")).toBe(false);
  expect(await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0)).toBe(true);
}
async function enroll(page: Page) {
  await page.waitForSelector("#mfa-enroll-code");
  await fill(page, "#mfa-enroll-code", "123456");
  await click(page, "Verify and continue");
  await waitStage(page, "recovery_codes");
}
const acknowledge = "I have saved my recovery codes — continue";

describe.skipIf(!hasBrowser)("installed administrator login UI", () => {
  it("shows QR/manual setup, eight codes before password change, then enters full only after the server confirms", async () => {
    const { page, state } = await fixture();
    try {
      await fill(page, "#login-email", testUser.email);
      await fill(page, "#login-password", temporaryPassword);
      await click(page, "Sign in");
      await page.waitForSelector("#mfa-manual-secret");
      expect(state.loginPayloadValid).toBe(true);
      expect(await page.$eval("canvas", el => (el as HTMLCanvasElement).width === 200)).toBe(true);
      expect(await page.$eval("#mfa-manual-secret", el => (el as HTMLInputElement).readOnly && (el as HTMLInputElement).value.length > 0)).toBe(true);
      await assertNoOverflow(page);
      await page.$eval('[data-testid="refresh-session"]', el => (el as HTMLButtonElement).click());
      await page.waitForNetworkIdle();
      expect(state.enrollRequests).toBe(1);
      await enroll(page);
      expect(await page.$$eval('ul[aria-label="One-time recovery codes"] li', els => els.length)).toBe(8);
      expect(await page.$("#initial-current-password")).toBeNull();
      expect(await page.$("#mfa-manual-secret")).toBeNull();
      await assertNoOverflow(page);
      // Even an explicit session refresh cannot dismiss the one-time copy.
      await page.$eval('[data-testid="refresh-session"]', el => (el as HTMLButtonElement).click());
      await page.waitForNetworkIdle();
      await waitStage(page, "recovery_codes");
      await click(page, acknowledge);
      await waitStage(page, "password_change");
      expect(await page.$('ul[aria-label="One-time recovery codes"]')).toBeNull();
      expect(await page.$eval("#initial-new-password", el => [(el as HTMLInputElement).minLength, (el as HTMLInputElement).maxLength])).toEqual([14, 256]);
      await fill(page, "#initial-current-password", temporaryPassword);
      await fill(page, "#initial-new-password", newPassphrase);
      await fill(page, "#initial-confirm-password", "a different long confirmation");
      await click(page, "Update password and enter portal");
      await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent?.includes("do not match"));
      expect(state.passwordRequests).toBe(0);
      await assertNoOverflow(page);
      await fill(page, "#initial-confirm-password", newPassphrase);
      await click(page, "Update password and enter portal");
      await waitStage(page, "full");
      expect(state.passwordPayloadValid).toBe(true);
      expect(await page.$('input[type="password"]')).toBeNull();
      await assertPrivate(page, state);
    } finally { await page.close(); }
  }, 20000);

  it("keeps direct-full enrollment behind recovery acknowledgment and supports manual QR fallback", async () => {
    const { page, state } = await fixture({ initialStage: "mfa_enroll", nextStage: "full", qrFail: true });
    try {
      await page.waitForFunction(() => document.body.textContent?.includes("QR code is unavailable"));
      expect(state.enrollRequests).toBe(1); // Includes Strict Mode's enrollment effect replay.
      await assertNoOverflow(page);
      await enroll(page);
      await page.$eval('[data-testid="refresh-session"]', el => (el as HTMLButtonElement).click());
      await page.waitForNetworkIdle();
      await waitStage(page, "recovery_codes");
      await click(page, acknowledge);
      await waitStage(page, "full");
      expect(state.passwordRequests).toBe(0);
      await assertPrivate(page, state);
    } finally { await page.close(); }
  }, 20000);

  it("offers an explicit enrollment retry, catches verify network failures, and clears secrets on cancel", async () => {
    const { page, state } = await fixture({ initialStage: "mfa_enroll", failEnrollment: true, failVerification: true });
    try {
      await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent?.includes("Could not start"));
      expect(state.enrollRequests).toBe(1);
      await click(page, "Retry authenticator setup");
      await page.waitForSelector("#mfa-enroll-code");
      expect(state.enrollRequests).toBe(2);
      await fill(page, "#mfa-enroll-code", "123456");
      await click(page, "Verify and continue");
      await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent?.includes("Could not reach"));
      await click(page, "Verify and continue");
      await waitStage(page, "recovery_codes");
      await click(page, "Cancel and return to sign-in");
      await waitStage(page, "anonymous");
      expect(await page.$("#mfa-manual-secret")).toBeNull();
      expect(await page.$('ul[aria-label="One-time recovery codes"]')).toBeNull();
      expect(await page.$eval("#login-password", el => (el as HTMLInputElement).value === "")).toBe(true);
      await assertPrivate(page, state);
    } finally { await page.close(); }
  }, 20000);

  it("keeps required password change open on server policy errors and clears fields on cancellation", async () => {
    const { page, state } = await fixture({ initialStage: "password_change", passwordError: "PASSWORD_POLICY_VIOLATION" });
    try {
      await fill(page, "#initial-current-password", temporaryPassword);
      await fill(page, "#initial-new-password", newPassphrase);
      await fill(page, "#initial-confirm-password", newPassphrase);
      await click(page, "Update password and enter portal");
      await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent?.includes("14–256"));
      await waitStage(page, "password_change");
      expect(state.passwordRequests).toBe(1);
      await assertNoOverflow(page);
      await click(page, "Cancel and return to sign-in");
      await waitStage(page, "anonymous");
      expect(await page.$("#initial-current-password")).toBeNull();
      expect(await page.$eval("#login-password", el => (el as HTMLInputElement).value === "")).toBe(true);
      await assertPrivate(page, state);
    } finally { await page.close(); }
  }, 20000);

  it("routes an existing authenticator verification to required password change without inventing codes", async () => {
    const { page, state } = await fixture({ initialStage: "mfa_verify" });
    try {
      await fill(page, 'input[autocomplete="one-time-code"]', "123456");
      await click(page, "Verify and sign in");
      await waitStage(page, "password_change");
      expect(await page.$('ul[aria-label="One-time recovery codes"]')).toBeNull();
      expect(state.passwordRequests).toBe(0);
      await assertPrivate(page, state);
    } finally { await page.close(); }
  }, 20000);
});
