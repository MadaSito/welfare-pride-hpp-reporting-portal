import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

// Read-only browser harness with intercepted synthetic API responses. No repository,
// storage, real accounts, supplied figures, or default data directories are opened.
const chromePath = process.env.CHROME_PATH || "/usr/bin/chromium";
const hasBrowser = existsSync(chromePath);
let dir: string, vite: ViteDevServer, browser: Browser, origin: string;
const primaryFields = {
  staff_members: "Number of staff making the calls",
  total_calls: "Total Number of Calls",
  members_reached: "Total number of members REACHED",
  referrals: "Number of Referrals",
  calls_round1: "1st Round Completed Calls",
  calls_round2: "2nd Round Completed Calls",
  calls_round3: "3rd Round Completed Calls",
};
const countKeys = [
  ...Object.keys(primaryFields),
  "aca_yes",
  "aca_no",
  "head_of_household",
  "calls_jhpp",
  "calls_wr",
];
const metric = {
  reporting_year: 2030,
  reporting_month: 1,
  staff_members: 2,
  total_calls: 99,
  members_reached: 11,
  referrals: 7,
  calls_round1: 2,
  calls_round2: 3,
  calls_round3: 0,
  aca_yes: 1,
  aca_no: 1,
  head_of_household: 1,
  calls_jhpp: 1,
  calls_wr: 2,
  notes: "Synthetic test fixture",
  kpis: { totalCalls: 99, totalReferrals: 7 },
};
const series = [
  {
    year: 2030,
    month: 1,
    round1: 2,
    round2: 3,
    round3: 0,
    totalCalls: 99,
    membersReached: 11,
    referrals: 7,
    acaYes: 1,
    acaNo: 1,
    acaRate: 50,
    headOfHousehold: 1,
    staff: 2,
    callsPerStaff: 49.5,
    jhpp: 1,
    wr: 2,
  },
  {
    year: 2030,
    month: 2,
    round1: 4,
    round2: 0,
    round3: 0,
    totalCalls: 0,
    membersReached: 0,
    referrals: 0,
    acaYes: 0,
    acaNo: 0,
    acaRate: 0,
    headOfHousehold: 0,
    staff: 1,
    callsPerStaff: 0,
    jhpp: 2,
    wr: 2,
  },
];
const summary = {
  year: 2030,
  monthsWithData: 2,
  monthlySeries: series,
  latestDelta: null,
  totals: {
    total_calls: 99,
    members_reached: 11,
    referrals: 7,
    totalCalls: 99,
    totalReferrals: 7,
    calls_round1: 6,
    calls_round2: 3,
    calls_round3: 0,
    round1Rate: 6.1,
    round2Rate: 3,
    round3Rate: 0,
    totalAca: 2,
    aca_yes: 1,
    aca_no: 1,
    acaRate: 50,
    head_of_household: 1,
    staff_members: 3,
    callsPerStaff: 33,
    calls_jhpp: 3,
    calls_wr: 4,
    jhppShare: 42.9,
    wrShare: 57.1,
  },
};

beforeAll(async () => {
  if (!hasBrowser) return;
  dir = mkdtempSync(path.join(os.tmpdir(), "wp-monthly-fields-ui-"));
  const harness: Plugin = {
    name: "monthly-fields-ui-harness",
    resolveId(id) {
      return id === "virtual:monthly-fields-ui" ? "\0monthly-fields-ui" : null;
    },
    load(id) {
      if (id !== "\0monthly-fields-ui") return;
      return `import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {AuthProvider, useAuth} from '/src/contexts/AuthContext.tsx';
        import {BrandingProvider} from '/src/contexts/BrandingContext.tsx';
        import {ThemeProvider} from '/src/contexts/ThemeContext.tsx';
        import {Layout} from '/src/components/Layout.tsx';
        import {MetricsEntryPage} from '/src/pages/MetricsEntryPage.tsx';
        import {DashboardPage} from '/src/pages/DashboardPage.tsx';
        import '/src/index.css';
        function Shell() {
          const auth = useAuth();
          if (auth.loading) return React.createElement('p', null, 'Loading');
          return React.createElement(Layout, null, React.createElement(new URLSearchParams(location.search).has('dashboard') ? DashboardPage : MetricsEntryPage));
        }
        createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(BrandingProvider, null, React.createElement(ThemeProvider, null, React.createElement(AuthProvider, null, React.createElement(Shell))))));`;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(
          '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:monthly-fields-ui"></script></body></html>'
        );
      });
    },
  };
  vite = await createServer({
    configFile: false,
    root: path.resolve("client"),
    cacheDir: path.join(dir, "vite-cache"),
    resolve: { alias: { "@": path.resolve("client/src") } },
    plugins: [react({ fastRefresh: false }), tailwindcss(), harness],
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await vite.listen();
  origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    userDataDir: path.join(dir, "chrome-profile"),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}, 30000);

afterAll(async () => {
  if (browser) await browser.close();
  if (vite) await vite.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

type Options = {
  dashboard?: boolean;
  existing?: Record<string, unknown>;
  viewOnly?: boolean;
  saveError?: boolean;
  loadError?: boolean;
};
async function fixture(options: Options = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(15000);
  await page.setViewport({ width: 320, height: 740 });
  const state = {
    writes: [] as {
      method: string;
      payload: Record<string, unknown>;
      csrf?: string;
    }[],
    errors: [] as string[],
  };
  page.on("pageerror", err => state.errors.push(String(err)));
  await page.setRequestInterception(true);
  page.on("request", req => {
    const url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) {
      void req.continue();
      return;
    }
    let status = 200;
    let data: unknown = {};
    if (req.method() !== "GET") {
      state.writes.push({
        method: req.method(),
        payload: JSON.parse(req.postData() || "{}"),
        csrf: req.headers()["x-csrf-token"],
      });
      if (
        req.method() === "PUT" &&
        /^\/api\/v1\/metrics\/\d+\/\d+$/.test(url.pathname)
      ) {
        status = options.saveError ? 400 : 200;
        data = options.saveError
          ? { error: "Counts must be nonnegative safe integers." }
          : { kpis: { totalCalls: state.writes.at(-1)!.payload.total_calls } };
      } else {
        status = 405;
        data = { error: "UNEXPECTED_WRITE" };
      }
    } else if (url.pathname === "/api/v1/auth/session") {
      data = {
        stage: "full",
        csrf: "mock-monthly-csrf",
        user: {
          id: "synthetic-manager",
          email: "fixture@example.org",
          display_name: "Synthetic fixture",
          role: options.viewOnly ? "view_only" : "manager",
          status: "active",
          tenant_id: "synthetic-tenant",
          auth_provider: "local",
        },
      };
    } else if (url.pathname === "/api/v1/branding") {
      data = {
        company_name: "Welfare Pride",
        tagline: "Outreach Reporting Dashboard Portal",
        icon_url: "/assets/branding/welfare-pride-icon.png",
      };
    } else if (url.pathname === "/api/v1/dashboard/summary") data = summary;
    else if (url.pathname === "/api/v1/metrics/years") data = { years: [2030] };
    else if (/^\/api\/v1\/metrics\/\d+\/\d+$/.test(url.pathname)) {
      if (options.loadError) {
        status = 503;
        data = { error: "UNAVAILABLE" };
      } else if (
        options.existing &&
        Number(url.pathname.split("/").at(-1)) !== 12
      )
        data = options.existing;
      else {
        status = 404;
        data = { error: "Metric not found" };
      }
    } else {
      status = 404;
      data = { error: "UNMOCKED_API" };
    }
    void req.respond({
      status,
      contentType: "application/json",
      body: JSON.stringify(data),
      headers: { "cache-control": "no-store" },
    });
  });
  await page.goto(origin + (options.dashboard ? "/?dashboard=1" : "/"), {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector(
    options.loadError
      ? '[role="alert"]'
      : options.dashboard
        ? 'section[aria-label="Key performance indicators"] article'
        : "#metric-total_calls:not(:disabled)",
    { timeout: 20000 }
  );
  if (options.dashboard)
    await page.waitForFunction(() =>
      document.querySelector("article")?.textContent?.includes("99")
    );
  return { page, state, context };
}
async function fill(page: Page, key: string, value: string) {
  await page.$eval(
    `[name="${key}"]`,
    (el, input) => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(el, input);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    value
  );
}
async function submit(page: Page) {
  await page.$eval('button[type="submit"]', el =>
    (el as HTMLButtonElement).click()
  );
}
async function click(page: Page, text: string) {
  await page.evaluate(t => {
    const button = Array.from(document.querySelectorAll("button")).find(
      b => b.textContent?.trim() === t
    );
    if (!button) throw new Error(`Missing button: ${t}`);
    button.click();
  }, text);
}
async function previewValue(page: Page, label: string) {
  return page.$eval(
    'aside[aria-label="Live monthly summary"]',
    (el, text) =>
      Array.from(el.querySelectorAll("dl > div"))
        .find(row => row.querySelector("dt")?.textContent === text)
        ?.querySelector("dd")?.textContent,
    label
  );
}
async function cardValue(page: Page, title: string) {
  return page.$$eval(
    "article",
    (cards, text) =>
      cards
        .find(card => card.querySelector("p")?.textContent === text)
        ?.querySelector("p + div")
        ?.textContent?.trim(),
    title
  );
}
async function assertNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
}

describe.skipIf(!hasBrowser)("independent monthly fields UI", () => {
  it("shows all seven exact accessible fields at zero, saves numbers independently, and fits 320px", async () => {
    const { page, state, context } = await fixture();
    try {
      for (const [key, label] of Object.entries(primaryFields)) {
        expect(
          await page.$eval(`#metric-${key}`, el => {
            const input = el as HTMLInputElement;
            return {
              label: input.labels?.[0]?.textContent?.trim(),
              value: input.value,
              min: input.min,
              max: input.max,
              step: input.step,
            };
          })
        ).toEqual({
          label,
          value: "0",
          min: "0",
          max: String(Number.MAX_SAFE_INTEGER),
          step: "1",
        });
      }
      expect(
        await page.$$eval(
          'section[aria-labelledby="additional-fields-heading"] input',
          els => els.every(el => !(el as HTMLInputElement).required)
        )
      ).toBe(true);
      expect(state.writes).toEqual([]);
      await assertNoOverflow(page);
      for (const [key, value] of Object.entries({
        staff_members: 2,
        total_calls: 99,
        members_reached: 11,
        referrals: 7,
        calls_round1: 2,
        calls_round2: 3,
        calls_round3: 0,
        calls_jhpp: 1,
        calls_wr: 2,
      }))
        await fill(page, key, String(value));
      expect(await previewValue(page, primaryFields.total_calls)).toBe("99");
      expect(await previewValue(page, primaryFields.members_reached)).toBe(
        "11"
      );
      expect(await previewValue(page, primaryFields.referrals)).toBe("7");
      expect(await previewValue(page, "JHPP / WR destination split")).toBe(
        "33.3% / 66.7%"
      );
      await page.focus("#metric-total_calls");
      expect(
        await page.$eval(
          "#metric-total_calls",
          el => el === document.activeElement
        )
      ).toBe(true);
      await submit(page);
      await page.waitForFunction(() =>
        document
          .querySelector('[role="status"]')
          ?.textContent?.includes("99 total calls")
      );
      expect(state.writes).toHaveLength(1);
      expect(state.writes[0].csrf).toBe("mock-monthly-csrf");
      expect(state.writes[0].payload).toMatchObject({
        total_calls: 99,
        members_reached: 11,
        referrals: 7,
        calls_round1: 2,
        calls_round2: 3,
        calls_round3: 0,
      });
      for (const key of countKeys)
        expect(typeof state.writes[0].payload[key]).toBe("number");
      await fill(page, "total_calls", "");
      await fill(page, "members_reached", "");
      await fill(page, "referrals", "0");
      expect(await previewValue(page, primaryFields.total_calls)).toBe("0");
      await submit(page);
      await page.waitForFunction(() =>
        document
          .querySelector('[role="status"]')
          ?.textContent?.includes("0 total calls")
      );
      expect(state.writes[1].payload).toMatchObject({
        total_calls: 0,
        members_reached: 0,
        referrals: 0,
        calls_round1: 2,
        calls_round2: 3,
      });
      expect(state.errors).toEqual([]);
      await assertNoOverflow(page);
    } finally {
      await context.close();
    }
  }, 30000);

  it("retains explicit stored zero and legacy values, and clears an absent month without writes", async () => {
    const { page, state, context } = await fixture({
      existing: {
        ...metric,
        total_calls: 0,
        referrals: 0,
        kpis: { totalCalls: 5, totalReferrals: 3 },
      },
    });
    try {
      expect(
        await page.$eval(
          "#metric-total_calls",
          el => (el as HTMLInputElement).value
        )
      ).toBe("0");
      expect(
        await page.$eval(
          "#metric-referrals",
          el => (el as HTMLInputElement).value
        )
      ).toBe("0");
      expect(await previewValue(page, primaryFields.total_calls)).toBe("0");
      await submit(page);
      await page.waitForFunction(() =>
        document
          .querySelector('[role="status"]')
          ?.textContent?.includes("Saved")
      );
      expect(state.writes[0].payload).toMatchObject({
        total_calls: 0,
        referrals: 0,
        aca_yes: 1,
        aca_no: 1,
        head_of_household: 1,
        calls_jhpp: 1,
        calls_wr: 2,
        notes: metric.notes,
      });
      await page.select('[name="reporting_month"]', "12");
      await page.waitForSelector("#metric-total_calls:not(:disabled)");
      expect(
        await page.$$eval('input[id^="metric-"]', els =>
          els.every(el => (el as HTMLInputElement).value === "0")
        )
      ).toBe(true);
      expect(
        await page.$eval(
          '[name="notes"]',
          el => (el as HTMLTextAreaElement).value
        )
      ).toBe("");
      expect(state.writes).toHaveLength(1);
      expect(state.errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 20000);

  it("loads null legacy totals from server KPIs without changing legacy counts", async () => {
    const { page, state, context } = await fixture({
      existing: {
        ...metric,
        total_calls: null,
        referrals: null,
        members_reached: 0,
        kpis: { totalCalls: 5, totalReferrals: 3 },
      },
    });
    try {
      expect(await previewValue(page, primaryFields.total_calls)).toBe("5");
      expect(await previewValue(page, primaryFields.referrals)).toBe("3");
      expect(
        await page.$eval(
          "#metric-calls_round2",
          el => (el as HTMLInputElement).value
        )
      ).toBe("3");
      expect(state.writes).toEqual([]);
      expect(state.errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 20000);

  it("prevents negative, fractional and unsafe counts, allows the safe maximum, and shows API errors", async () => {
    const { page, state, context } = await fixture({ saveError: true });
    try {
      for (const key of ["total_calls", "members_reached", "referrals"]) {
        for (const value of ["-1", "1.5", "9007199254740992"]) {
          await fill(page, key, value);
          expect(
            await page.$eval(`#metric-${key}`, el =>
              (el as HTMLInputElement).checkValidity()
            )
          ).toBe(false);
          await submit(page);
          expect(state.writes).toEqual([]);
        }
        await fill(page, key, "0");
      }
      // Defense in depth also catches submit events that bypass native validation.
      await fill(page, "total_calls", "1.5");
      await page.$eval("form", el =>
        el.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        )
      );
      await page.waitForSelector('[role="alert"]');
      expect(state.writes).toEqual([]);
      await fill(page, "total_calls", String(Number.MAX_SAFE_INTEGER));
      expect(
        await page.$eval("#metric-total_calls", el =>
          (el as HTMLInputElement).checkValidity()
        )
      ).toBe(true);
      await submit(page);
      await page.waitForFunction(() =>
        document
          .querySelector('[role="alert"]')
          ?.textContent?.includes("Counts must be")
      );
      expect(state.writes).toHaveLength(1);
      expect(state.writes[0].payload.total_calls).toBe(Number.MAX_SAFE_INTEGER);
      expect(state.errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 20000);

  it("prevents saving over an existing month that failed to load", async () => {
    const { page, state, context } = await fixture({ loadError: true });
    try {
      expect(
        await page.$eval('[role="alert"]', el => el.textContent)
      ).toContain("Could not load this reporting month");
      expect(
        await page.$eval(
          'button[type="submit"]',
          el => (el as HTMLButtonElement).disabled
        )
      ).toBe(true);
      await page.$eval("form", el =>
        el.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        )
      );
      expect(state.writes).toEqual([]);
      expect(state.errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 20000);

  it("keeps year and month-filter cards, chart series and table independent, including explicit zero", async () => {
    const { page, state, context } = await fixture({ dashboard: true });
    try {
      expect(await cardValue(page, primaryFields.total_calls)).toBe("99");
      expect(await cardValue(page, primaryFields.members_reached)).toBe("11");
      expect(await cardValue(page, primaryFields.referrals)).toBe("7");
      expect(await cardValue(page, primaryFields.calls_round1)).toBe("6");
      await click(page, "Jan");
      expect(await cardValue(page, primaryFields.total_calls)).toBe("99");
      expect(await cardValue(page, primaryFields.members_reached)).toBe("11");
      expect(await cardValue(page, primaryFields.referrals)).toBe("7");
      expect(await cardValue(page, primaryFields.calls_round1)).toBe("2");
      expect(
        await page.$$eval(
          "article",
          cards =>
            cards.find(
              card =>
                card.querySelector("p")?.textContent === "Referrals · JHPP"
            )?.textContent
        )
      ).toContain("33.3% of JHPP / WR destination counts");
      expect(
        await page.$$eval("th", cells => cells.map(cell => cell.textContent))
      ).toEqual(
        expect.arrayContaining([
          "Total calls",
          "Members reached",
          "Referrals",
          "R1 calls",
          "R2 calls",
          "R3 calls",
        ])
      );
      const rows = await page.$$eval("tbody tr", rows =>
        rows.map(row =>
          Array.from(row.querySelectorAll("td")).map(cell => cell.textContent)
        )
      );
      expect(rows[0].slice(1, 7)).toEqual(["2", "3", "0", "99", "11", "7"]);
      expect(rows[1].slice(1, 7)).toEqual(["4", "0", "0", "0", "0", "0"]);
      expect(await page.$$eval(".recharts-line", lines => lines.length)).toBe(
        4
      );
      const chartLegends = await page.$$eval(
        ".recharts-legend-item-text",
        labels => labels.map(label => label.textContent)
      );
      expect(chartLegends).toEqual(
        expect.arrayContaining([
          "Total calls",
          "Members reached",
          "Referrals",
          "Round 1",
          "Round 2",
          "Round 3",
        ])
      );
      await click(page, "Feb");
      expect(await cardValue(page, primaryFields.total_calls)).toBe("0");
      expect(await cardValue(page, primaryFields.members_reached)).toBe("0");
      expect(await cardValue(page, primaryFields.referrals)).toBe("0");
      expect(await cardValue(page, primaryFields.calls_round1)).toBe("4");
      expect(
        await page.$$eval(
          "article",
          cards =>
            cards.find(
              card =>
                card.querySelector("p")?.textContent === "Referrals · JHPP"
            )?.textContent
        )
      ).toContain("50% of JHPP / WR destination counts");
      await click(page, "Mar");
      expect(await cardValue(page, primaryFields.total_calls)).toBe("0");
      expect(await cardValue(page, primaryFields.members_reached)).toBe("0");
      expect(await cardValue(page, primaryFields.referrals)).toBe("0");
      await assertNoOverflow(page);
      expect(state.writes).toEqual([]);
      expect(state.errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 20000);

  it("preserves view-only dashboard controls without any automatic writes", async () => {
    const { page, state, context } = await fixture({
      dashboard: true,
      viewOnly: true,
    });
    try {
      expect(
        await page.$$eval('a[href="/metrics"]', links => links.length)
      ).toBe(0);
      expect(await cardValue(page, primaryFields.total_calls)).toBe("99");
      expect(state.writes).toEqual([]);
      expect(state.errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 20000);
});
