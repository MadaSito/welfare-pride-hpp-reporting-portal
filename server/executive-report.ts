import PDFDocument from "pdfkit";
import path from "node:path";
import { constants, closeSync, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeKpis, db, getBrandConfig, getReportAssignments, type DbUser, type MonthlyMetric, type Report } from "./repository";
import type { Role } from "./security";

export type ReportActor = { id: string; role: Role; tenantId: string | null };
export type ExecutiveMonth = {
  reporting_month: number; reporting_year: number; calls_round1: number; calls_round2: number;
  calls_round3: number; aca_yes: number; aca_no: number; head_of_household: number;
  staff_members: number; calls_jhpp: number; calls_wr: number;
  total_calls: number; members_reached: number; referrals: number;
};

// A null tenant is unscoped, not a shared tenant. Never associate its records with a report.
export function canAccessReport(report: Report, actor: ReportActor): boolean {
  if (!report.tenant_id || !actor.tenantId || report.tenant_id !== actor.tenantId) return false;
  if (actor.role !== "view_only") return true;
  if (report.status !== "published") return false;
  if (report.publish_target === "all" || report.publish_target === "view_users") return true;
  return report.publish_target === "specific_users" && getReportAssignments(report.id).includes(actor.id);
}

export function canReceiveReport(report: Report, user: DbUser | null): user is DbUser {
  if (!user || user.status !== "active" || user.auth_provider !== "local" || report.status !== "published") return false;
  // Only one valid, non-injectable mailbox; no arbitrary caller-provided recipient.
  if (!/^[^\s@,;<>\r\n]+@[^\s@,;<>\r\n]+\.[^\s@,;<>\r\n]+$/.test(user.email)) return false;
  return canAccessReport(report, { id: user.id, role: user.role, tenantId: user.tenant_id });
}

export function eligibleRecipients(report: Report, actorRole: Role): Pick<DbUser, "id" | "display_name" | "email">[] {
  if (!report.tenant_id || report.status !== "published") return [];
  const users = db.prepare("SELECT * FROM users WHERE tenant_id = ? AND status = 'active' AND auth_provider = 'local' ORDER BY display_name, id").all(report.tenant_id) as DbUser[];
  // Use canonicalized roles from the repository for legacy role names.
  return users.map(u => ({ ...u, role: canonicalRole(u.role) })).filter(u => (actorRole === "super_admin" || u.role !== "super_admin") && canReceiveReport(report, u)).map(({ id, display_name, email }) => ({ id, display_name, email }));
}
import { canonicalRole } from "./security";

const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function executiveReport(report: Report) {
  // Exact tenant equality is intentional: NULL metrics and other tenants must never be pooled.
  let sql = `SELECT * FROM monthly_metrics WHERE tenant_id = ?`;
  const args: (string | number)[] = [report.tenant_id ?? ""];
  if (report.reporting_year !== null) { sql += " AND reporting_year = ?"; args.push(report.reporting_year); }
  if (report.reporting_month !== null) { sql += " AND reporting_month = ?"; args.push(report.reporting_month); }
  sql += " ORDER BY reporting_year ASC, reporting_month ASC";
  const rows = report.tenant_id ? db.prepare(sql).all(...args) as MonthlyMetric[] : [];
  // Export only report measures, never notes, user IDs, or other row metadata.
  // The shared helper preserves explicit zero and falls back only for legacy NULL counts.
  const monthly: ExecutiveMonth[] = rows.map(m => {
    const k = computeKpis(m);
    return {
      reporting_month: m.reporting_month, reporting_year: m.reporting_year,
      staff_members: m.staff_members, total_calls: k.totalCalls,
      members_reached: k.membersReached, referrals: k.totalReferrals,
      calls_round1: m.calls_round1, calls_round2: m.calls_round2, calls_round3: m.calls_round3,
      aca_yes: m.aca_yes, aca_no: m.aca_no, head_of_household: m.head_of_household,
      calls_jhpp: m.calls_jhpp, calls_wr: m.calls_wr,
    };
  });
  const month = report.reporting_month === null ? null : monthNames[report.reporting_month - 1] || `Month ${report.reporting_month}`;
  const label = report.reporting_year !== null ? (month ? `${month} ${report.reporting_year}` : `${report.reporting_year}`) : (month ? `${month} · all years` : "All periods");
  const sum = (key: keyof ExecutiveMonth) => monthly.length ? monthly.reduce((n, m) => n + m[key], 0) : null;
  const round1 = sum("calls_round1"), round2 = sum("calls_round2"), round3 = sum("calls_round3");
  const acaYes = sum("aca_yes"), acaNo = sum("aca_no"), callsJhpp = sum("calls_jhpp"), callsWr = sum("calls_wr");
  const totals = {
    totalCalls: sum("total_calls"), membersReached: sum("members_reached"), round1, round2, round3,
    acaYes, acaNo, acaRate: acaYes === null || !((acaYes ?? 0) + (acaNo ?? 0)) ? null : Math.round(acaYes / (acaYes + acaNo!) * 1000) / 10,
    headOfHousehold: sum("head_of_household"), staffMembers: sum("staff_members"), callsJhpp, callsWr,
    totalReferrals: sum("referrals"),
  };
  let layout_config: unknown = {};
  try { if (report.layout_config) layout_config = JSON.parse(report.layout_config); } catch { /* malformed legacy config */ }
  return { report: { ...report, layout_config }, period: { label }, totals, monthly };
}
export type ExecutiveReport = ReturnType<typeof executiveReport>;

function asset(name: string): string {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(root, "../branding", name), path.resolve(root, "branding", name)];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`Required local branding asset missing: ${name}`);
  return found;
}

const DEFAULT_PRIMARY = "#5A92C9", DEFAULT_SECONDARY = "#D58240";
const DEFAULT_LOGO_URL = "/assets/branding/welfare-pride-main-logo.webp";
const DEFAULT_LOGO_FILE = "welfare-pride-main-logo.png";

type ReportBrandInput = { company_name?: unknown; primary_color?: unknown; secondary_color?: unknown; logo_url?: unknown };
export function reportBrand(config: ReportBrandInput | null | undefined) {
  const validColor = (value: unknown, fallback: string) => typeof value === "string" && value.length === 7 && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
  // Prevent legacy control characters from disrupting page furniture or metadata.
  const name = typeof config?.company_name === "string" ? config.company_name.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 120) : "";
  return { company: name || "Welfare Pride", primary: validColor(config?.primary_color, DEFAULT_PRIMARY), secondary: validColor(config?.secondary_color, DEFAULT_SECONDARY), logo: config?.logo_url };
}

/** WCAG relative luminance; choose the stronger of black and white (always >= 4.5:1). */
export function reportContrastText(hex: string): "#000000" | "#FFFFFF" {
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#FFFFFF";
}

/** Only exact branding URLs mapped to regular PNG/JPEG files; never fetch URLs or follow symlinks. */
export function loadReportLogo(logo: unknown, brandingDir = path.dirname(asset(DEFAULT_LOGO_FILE))): Buffer {
  const fallback = () => readFileSync(path.join(brandingDir, DEFAULT_LOGO_FILE));
  if (logo === DEFAULT_LOGO_URL) return fallback();
  if (typeof logo !== "string") return fallback();
  const match = /^\/assets\/branding\/([a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|jpe?g))$/i.exec(logo);
  if (!match || match[0] !== logo || match[1].includes("..")) return fallback();
  let fd: number | undefined;
  try {
    fd = openSync(path.join(brandingDir, match[1]), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return fallback();
    const bytes = readFileSync(fd);
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if ((match[2].toLowerCase() === "png" && png) || (match[2].toLowerCase() !== "png" && jpeg)) return bytes;
  } catch { /* Missing, inaccessible, or unsafe file. */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return fallback();
}

/** A self-contained PDF. Staff is explicitly a sum of monthly entries, never a unique headcount. */
export function renderExecutivePdf(data: ExecutiveReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const brand = reportBrand(getBrandConfig());
      // Keep the header and footer outside PDFKit's content area on every page.
      const doc = new PDFDocument({ size: "A4", margins: { top: 105, bottom: 62, left: 42, right: 42 }, bufferPages: true, info: { Title: `${brand.company} Executive Report`, Author: brand.company } });
      const chunks: Buffer[] = [];
      doc.on("data", chunk => chunks.push(Buffer.from(chunk)));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.registerFont("Roboto", asset("Roboto-Regular.ttf"));
      doc.registerFont("RobotoBold", asset("Roboto-Bold.ttf"));
      doc.registerFont("RobotoMedium", asset("Roboto-Medium.ttf"));
      const W = doc.page.width, left = 42, width = W - 84, blue = brand.primary, orange = brand.secondary, ink = "#24374A", muted = "#5F7181";
      const headerText = reportContrastText(blue);
      let logo = loadReportLogo(brand.logo);
      try {
        const image = (doc as unknown as { openImage: (image: Buffer) => { width: number; height: number } }).openImage(logo);
        if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.width * image.height > 25_000_000) throw new Error("Invalid logo dimensions");
      } catch { logo = loadReportLogo(DEFAULT_LOGO_URL); }
      const bottom = () => doc.page.height - doc.page.margins.bottom;
      const ensureSpace = (height: number) => {
        if (doc.y + height > bottom()) doc.addPage();
      };
      const generatedAt = new Date().toISOString();

      doc.font("RobotoBold").fontSize(22).fillColor(ink).text("Executive report", left, doc.y, { width });
      doc.moveDown(0.25);
      // No height or ellipsis: PDFKit wraps long words and continues onto new pages.
      doc.font("RobotoMedium").fontSize(13).fillColor(ink).text(data.report.title, left, doc.y, { width, lineGap: 2 });
      doc.moveDown(0.35);
      doc.font("Roboto").fontSize(10).fillColor(muted).text(`${data.period.label}  |  Report v${data.report.version}`, left, doc.y, { width });
      doc.moveDown(0.35);
      doc.font("Roboto").fontSize(9).fillColor(muted).text(`Generated: ${generatedAt} (UTC)`, left, doc.y, { width });
      doc.moveDown(0.35);
      doc.text("Generated from current metric data. Values may change as underlying entries are updated; regenerate this report to see the latest data.", left, doc.y, { width, lineGap: 1 });
      if (data.report.description) {
        doc.moveDown(0.7);
        // Keep the section heading with at least one line of the description.
        ensureSpace(36);
        doc.font("RobotoBold").fontSize(11).fillColor(ink).text("Description", left, doc.y, { width });
        doc.moveDown(0.25);
        doc.font("Roboto").fontSize(10).fillColor(ink).text(data.report.description, left, doc.y, { width, lineGap: 2 });
      }
      doc.moveDown(0.8);

      const fmt = (n: number | null, suffix = "") => n === null ? "—" : `${n.toLocaleString("en-US")}${suffix}`;
      const t = data.totals;
      const cards: [string, string][] = [["Staff making calls*",fmt(t.staffMembers)],["Total calls",fmt(t.totalCalls)],["Members reached",fmt(t.membersReached)],["Referrals",fmt(t.totalReferrals)],["Completed round 1",fmt(t.round1)],["Completed round 2",fmt(t.round2)],["Completed round 3",fmt(t.round3)],["ACA yes",fmt(t.acaYes)],["ACA no",fmt(t.acaNo)],["ACA yes rate",fmt(t.acaRate,"%")],["Heads of household",fmt(t.headOfHousehold)],["JHPP calls",fmt(t.callsJhpp)],["WR calls",fmt(t.callsWr)]];
      const gap = 8, cardWidth = (width - gap * 3) / 4;
      const cardRows = Math.ceil(cards.length / 4);
      // Keep the complete summary together instead of drawing cards across a page break.
      ensureSpace(cardRows * 60 + 45);
      doc.font("RobotoBold").fontSize(12).fillColor(ink).text("Performance at a glance", left, doc.y, { width });
      doc.moveDown(0.45);
      const cardTop = doc.y;
      cards.forEach(([label, value], i) => {
        const x = left + (i % 4) * (cardWidth + gap), y = cardTop + Math.floor(i / 4) * 60;
        doc.roundedRect(x, y, cardWidth, 52, 4).fill("#F2F7FB");
        if (i === 0) doc.rect(x, y, 3, 52).fill(orange);
        doc.font("Roboto").fontSize(8).fillColor(muted).text(label, x + 8, y + 6, { width: cardWidth - 16 });
        doc.font("RobotoBold").fontSize(16);
        // Scale unusually large figures to their cell instead of clipping or overlapping.
        const valueWidth = doc.widthOfString(value);
        if (valueWidth > cardWidth - 16) doc.fontSize(16 * (cardWidth - 16) / valueWidth);
        doc.fillColor(ink).text(value, x + 8, y + 28, { width: cardWidth - 16, lineBreak: false });
      });
      doc.y = cardTop + cardRows * 60;
      doc.font("Roboto").fontSize(8).fillColor(muted).text("* Staff entries are summed across months, not unique people. ACA rate is yes / (yes + no).", left, doc.y, { width, lineGap: 1 });
      doc.text("Total calls, members reached, referrals, and completed rounds are independent measures. Only legacy entries without total calls or referrals use the prior round or JHPP/WR sums.", left, doc.y, { width, lineGap: 1 });
      doc.moveDown(1.2);

      const monthlyTable = (title: string, headings: string[], widths: number[], valuesFor: (m: ExecutiveMonth) => (string | number)[]) => {
        const scale = width / widths.reduce((a,b) => a+b, 0), columns = widths.map(v => v * scale);
        const headerHeight = 38;
        // Keep the section title, wrapped table header, and first row together.
        ensureSpace(data.monthly.length ? 85 : 45);
        doc.font("RobotoBold").fontSize(12).fillColor(ink).text(title, left, doc.y, { width });
        doc.moveDown(0.45);
        let y = doc.y;
        const tableHeader = () => {
          doc.rect(left, y, width, headerHeight).fill(blue);
          let x = left;
          // Black or white is selected for WCAG AA against the configured color.
          headings.forEach((h, i) => { doc.font("RobotoBold").fontSize(7).fillColor(headerText).text(h, x + 3, y + 7, { width: columns[i] - 6, align: i ? "right" : "left" }); x += columns[i]; });
          y += headerHeight;
        };
        if (!data.monthly.length) {
          doc.font("Roboto").fontSize(10).fillColor(muted).text("No metric data is available for this report period.", left, y, { width });
          return;
        }
        tableHeader();
        data.monthly.forEach((m, row) => {
          if (y + 21 > bottom()) { doc.addPage(); y = doc.y; tableHeader(); }
          if (row % 2 === 0) doc.rect(left, y, width, 21).fill("#F4F8FB");
          const values = valuesFor(m);
          let x = left;
          values.forEach((v, i) => {
            const value = typeof v === "number" ? v.toLocaleString("en-US") : v;
            doc.font("Roboto").fontSize(7.5);
            const valueWidth = doc.widthOfString(value);
            if (valueWidth > columns[i] - 4) doc.fontSize(7.5 * (columns[i] - 4) / valueWidth);
            doc.fillColor(ink).text(value, x + 2, y + 7, { width: columns[i] - 4, align: i ? "right" : "left", lineBreak: false });
            x += columns[i];
          });
          y += 21;
        });
        doc.y = y;
      };
      const periodValue = (m: ExecutiveMonth) => `${String(m.reporting_month).padStart(2, "0")}/${m.reporting_year}`;
      monthlyTable("Monthly detail", ["Period", "Staff making\ncalls*", "Total calls", "Members\nreached", "Referrals", "Completed\nround 1", "Completed\nround 2", "Completed\nround 3"], [62, 65, 59, 65, 55, 67, 67, 67], m => [periodValue(m), m.staff_members, m.total_calls, m.members_reached, m.referrals, m.calls_round1, m.calls_round2, m.calls_round3]);
      if (data.monthly.length) {
        doc.moveDown(1.2);
        monthlyTable("Monthly supplemental detail", ["Period", "ACA yes", "ACA no", "Heads of\nhousehold", "JHPP calls", "WR calls"], [72, 70, 70, 100, 100, 100], m => [periodValue(m), m.aca_yes, m.aca_no, m.head_of_household, m.calls_jhpp, m.calls_wr]);
      }

      // Apply repeating furniture after all flowing text, so page breaks cannot
      // change the active font or interfere with PDFKit's line wrapper.
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const savedBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        // The page remains white behind the black lettering of the logo.
        try { doc.image(logo, left, 24, { fit: [118, 56], valign: "center" }); }
        catch { doc.image(loadReportLogo(DEFAULT_LOGO_URL), left, 24, { fit: [118, 56], valign: "center" }); }
        // Scale long names to fit the fixed header/footer furniture without overlapping content.
        doc.font("RobotoBold").fontSize(10);
        const nameWidth = doc.widthOfString(brand.company);
        if (nameWidth > 198) doc.fontSize(10 * 198 / nameWidth);
        doc.fillColor(ink).text(brand.company, W - 240, 35, { width: 198, align: "right", lineBreak: false });
        doc.font("RobotoMedium").fontSize(9).fillColor(muted).text("HEALTH PLAN OUTREACH", W - 240, 52, { width: 198, align: "right", lineBreak: false });
        doc.moveTo(left, 88).lineTo(W - left, 88).lineWidth(1.5).strokeColor(blue).stroke();
        doc.moveTo(left, doc.page.height - 37).lineTo(W - left, doc.page.height - 37).lineWidth(0.5).strokeColor("#D5E1EA").stroke();
        const footer = `${brand.company}  |  Executive report     Page ${i + 1} of ${range.count}  |  Typeface: Roboto`;
        doc.font("Roboto").fontSize(8);
        const footerWidth = doc.widthOfString(footer);
        if (footerWidth > width) doc.fontSize(8 * width / footerWidth);
        doc.fillColor(muted).text(footer, left, doc.page.height - 29, { width, lineBreak: false });
        doc.page.margins.bottom = savedBottom;
      }
      doc.end();
    } catch (err) { reject(err); }
  });
}
