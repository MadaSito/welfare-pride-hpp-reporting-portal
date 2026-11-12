import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Download, FileText, Mail, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { useBranding } from "../contexts/BrandingContext";

interface ReportInfo {
  id: string;
  title: string;
  description: string | null;
  status: "draft" | "published" | "hidden";
  version: number;
}

interface MonthlyRow {
  reporting_month: number;
  reporting_year: number;
  calls_round1: number;
  calls_round2: number;
  calls_round3: number;
  aca_yes: number;
  aca_no: number;
  head_of_household: number;
  staff_members: number;
  calls_jhpp: number;
  calls_wr: number;
}

interface ExecutiveData {
  report: ReportInfo;
  period: { label: string };
  totals: {
    totalCalls: number | null;
    round1: number | null;
    round2: number | null;
    round3: number | null;
    acaYes: number | null;
    acaNo: number | null;
    acaRate: number | null;
    headOfHousehold: number | null;
    staffMembers: number | null;
    callsJhpp: number | null;
    callsWr: number | null;
    totalReferrals: number | null;
  };
  monthly: MonthlyRow[];
}

interface Recipient { id: string; display_name: string; email: string }

const DEFAULT_PRIMARY = "#5A92C9", DEFAULT_SECONDARY = "#D58240";
const DEFAULT_LOGO = "/assets/branding/welfare-pride-main-logo.webp";
const validColor = (value: unknown, fallback: string) => typeof value === "string" && value.length === 7 && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
const contrastText = (hex: string) => {
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#FFFFFF";
};

export function previewReportBrand(brand: { logo_url?: unknown; company_name?: unknown; primary_color?: unknown; secondary_color?: unknown } | null | undefined) {
  const candidate = brand?.logo_url;
  const filename = typeof candidate === "string" ? /^\/assets\/branding\/([a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:png|jpe?g))$/i.exec(candidate) : null;
  const logo = candidate === DEFAULT_LOGO || (filename && filename[0] === candidate && !filename[1].includes("..")) ? candidate as string : DEFAULT_LOGO;
  const company = typeof brand?.company_name === "string" ? brand.company_name.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 120) || "Welfare Pride" : "Welfare Pride";
  return { logo, company, primary: validColor(brand?.primary_color, DEFAULT_PRIMARY), secondary: validColor(brand?.secondary_color, DEFAULT_SECONDARY) };
}

const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const number = (value: number | null) => value !== null && Number.isFinite(value) ? value.toLocaleString() : "—";
const errorMessages: Record<string, string> = {
  REPORT_NOT_FOUND: "The report is unavailable or you no longer have access.",
  RECIPIENT_NOT_FOUND: "The selected recipient is no longer eligible.",
  REPORT_ACCESS_CHANGED: "Report or recipient access changed. Reopen the preview and try again.",
  REPORT_EMAIL_GLOBAL_BCC_CONFIGURED: "Email cannot be sent while a global BCC is configured.",
  REPORT_EMAIL_DISABLED: "The email engine is disabled. An administrator must enable it first.",
  REPORT_EMAIL_UNKNOWN: "The provider did not confirm acceptance. Verify with the recipient or provider before retrying; the report may already have been sent.",
  REPORT_EMAIL_FAILED: "The report email could not be sent.",
  REPORT_PDF_FAILED: "The report PDF could not be generated.",
  ACCESS_DENIED: "You do not have permission for this action.",
  INVALID_RECIPIENT: "Select a valid recipient.",
};
const errorText = async (response: Response, fallback: string) => {
  const body = await response.json().catch(() => null);
  const parts = [body?.error, body?.message, body?.detail].filter((value, index, all): value is string => typeof value === "string" && value.length > 0 && all.indexOf(value) === index);
  return parts.length ? `${fallback}: ${parts.map(part => errorMessages[part] || part).join(" — ")}` : `${fallback} (HTTP ${response.status}).`;
};

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="rounded-xl border border-[#dce7ef] bg-[#f7fafc] p-4">
    <p className="text-xs font-medium text-[#526b7d]">{label}</p>
    <p className="mt-2 text-2xl font-bold tracking-tight text-[#102f49] sm:text-3xl">{value}</p>
    {detail && <p className="mt-1 text-xs leading-5 text-[#526b7d]">{detail}</p>}
  </div>;
}

function Breakdown({ label, value, total, color }: { label: string; value: number | null; total: number | null; color: string }) {
  const width = value !== null && total !== null && total > 0 ? Math.max(0, Math.min(100, value / total * 100)) : 0;
  return <div>
    <div className="mb-1.5 flex items-center justify-between gap-2 text-xs"><span className="font-medium text-[#38556a]">{label}</span><span className="font-bold tabular-nums text-[#17374f]">{number(value)}</span></div>
    <div className="h-2 overflow-hidden rounded-full bg-[#e9f0f5]" aria-hidden="true"><div className="h-full rounded-full" style={{ width: `${width}%`, backgroundColor: color }} /></div>
  </div>;
}

export function ExecutivePage({ data, logo, company, primary, secondary }: { data: ExecutiveData; logo: string; company: string; primary: string; secondary: string }) {
  const { report, period, totals: t } = data;
  const rows = [...data.monthly].sort((a, b) => a.reporting_year - b.reporting_year || a.reporting_month - b.reporting_month);
  const responses = t.acaYes !== null && t.acaNo !== null ? t.acaYes + t.acaNo : null;
  return <article className="mx-auto w-full max-w-5xl overflow-hidden bg-white text-[#102f49] shadow-sm" style={{ fontFamily: 'WelfareRoboto, Roboto, Arial, sans-serif' }}>
    <div className="h-1.5" style={{ backgroundColor: primary }} />
    <div className="px-5 py-7 sm:px-9 sm:py-9 lg:px-12">
      <header>
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#dce7ef] pb-6">
          <div className="flex items-center gap-3">
            <div className="flex h-14 w-28 items-center justify-center overflow-hidden rounded-lg border border-[#dce7ef] bg-white p-1"><img src={logo} onError={e => { if (e.currentTarget.getAttribute("src") !== DEFAULT_LOGO) e.currentTarget.src = DEFAULT_LOGO; }} alt={`${company} logo`} className="h-full w-full object-contain" /></div>
            <div className="min-w-0"><p className="break-all text-sm font-bold text-[#183b55]">{company}</p><p className="mt-0.5 text-xs text-[#5c7283]">HPP Reporting</p></div>
          </div>
          <div className="text-left sm:text-right"><p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#38556a]">Executive report</p><p className="mt-1 text-xs font-medium text-[#526b7d]">{period.label} · Version {report.version}</p></div>
        </div>
        <div className="py-7 sm:py-9">
          <p className="text-xs font-bold uppercase tracking-[.17em] text-[#38556a]">Reporting period · {period.label}</p>
          <h3 className="mt-2 break-words text-2xl font-bold tracking-tight text-[#102f49] sm:text-4xl">{report.title}</h3>
          {report.description && <p className="mt-3 max-w-3xl whitespace-pre-wrap break-words text-sm leading-6 text-[#526b7d]">{report.description}</p>}
          <p className="mt-4 text-xs leading-5 text-[#526b7d]">Generated from current metric data for {period.label}. Values can change as underlying entries are updated; this is not a fixed snapshot. The executive layout includes all measures, regardless of widget selections.</p>
        </div>
      </header>

      <section aria-labelledby="executive-overview">
        <div className="mb-4 flex items-center gap-3"><span className="h-5 w-1 rounded-full" style={{ backgroundColor: secondary }} /><h4 id="executive-overview" className="text-sm font-bold uppercase tracking-[.12em]">At a glance</h4></div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric label="Total calls" value={number(t.totalCalls)} detail="Across all three rounds" />
          <Metric label="ACA YES rate" value={responses && t.acaRate !== null ? `${number(t.acaRate)}%` : "—"} detail={responses ? `${number(t.acaYes)} of ${number(responses)} responses` : responses === null ? "No metric data" : "No ACA responses"} />
          <Metric label="Head of household" value={number(t.headOfHousehold)} detail="Reported for the period" />
          <Metric label="Total referrals" value={number(t.totalReferrals)} detail="JHPP and WR combined" />
        </div>
      </section>

      <div className="mt-8 grid gap-5 md:grid-cols-2">
        <section className="rounded-xl border border-[#dce7ef] p-5" aria-labelledby="calls-heading">
          <div className="mb-5 flex items-start justify-between gap-3"><div><h4 id="calls-heading" className="text-base font-bold">Calls by round</h4><p className="mt-1 text-xs text-[#5c7283]">Distribution of calls in the period</p></div><span className="rounded-full bg-[#edf5fb] px-2.5 py-1 text-xs font-bold text-[#315f83]">{number(t.totalCalls)} total</span></div>
          <div className="space-y-4"><Breakdown label="Round 1" value={t.round1} total={t.totalCalls} color={primary} /><Breakdown label="Round 2" value={t.round2} total={t.totalCalls} color={primary} /><Breakdown label="Round 3" value={t.round3} total={t.totalCalls} color={secondary} /></div>
        </section>
        <section className="rounded-xl border border-[#dce7ef] p-5" aria-labelledby="outcomes-heading">
          <h4 id="outcomes-heading" className="text-base font-bold">Responses & referrals</h4><p className="mt-1 text-xs text-[#5c7283]">Reported totals for the period</p>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            {[['ACA YES', t.acaYes], ['ACA NO', t.acaNo], ['JHPP calls', t.callsJhpp], ['WR calls', t.callsWr]].map(([label, value]) => <div key={label} className="border-t border-[#e7eef3] pt-3"><dt className="text-xs text-[#5c7283]">{label}</dt><dd className="mt-1 font-bold tabular-nums text-[#183b55]">{number(value as number | null)}</dd></div>)}
          </dl>
        </section>
      </div>

      <section className="mt-8" aria-labelledby="monthly-heading">
        <div className="flex flex-wrap items-end justify-between gap-2"><div><h4 id="monthly-heading" className="text-base font-bold">Monthly detail</h4><p className="mt-1 text-xs leading-5 text-[#5c7283]">Metric entries within {period.label}. Scroll horizontally to see all measures.</p></div><p className="text-xs font-medium text-[#5c7283]">{number(rows.length)} {rows.length === 1 ? 'entry' : 'entries'}</p></div>
        {rows.length === 0 ? <p className="mt-4 rounded-xl border border-[#dce7ef] bg-[#f7fafc] p-4 text-sm text-[#526b7d]">No monthly metric entries are available for this period.</p> : <div className="mt-4 overflow-x-auto rounded-xl border border-[#dce7ef]" tabIndex={0} role="region" aria-label="Monthly report details, scroll horizontally">
          <table className="w-full min-w-[850px] border-collapse text-left text-xs">
            <thead style={{ backgroundColor: primary, color: contrastText(primary) }}><tr>{["Period", "Round 1", "Round 2", "Round 3", "ACA YES", "ACA NO", "Head of household", "Staff", "JHPP", "WR"].map((label, i) => <th key={label} scope="col" className={`whitespace-nowrap px-3 py-3 font-bold ${i ? 'text-right' : ''}`}>{label}</th>)}</tr></thead>
            <tbody className="divide-y divide-[#e8eef3]">{rows.map((m, i) => <tr key={`${m.reporting_year}-${m.reporting_month}-${i}`}><th scope="row" className="whitespace-nowrap px-3 py-3 font-semibold">{months[m.reporting_month - 1] || `Month ${m.reporting_month}`} {m.reporting_year}</th>{[m.calls_round1, m.calls_round2, m.calls_round3, m.aca_yes, m.aca_no, m.head_of_household, m.staff_members, m.calls_jhpp, m.calls_wr].map((v, index) => <td key={index} className="px-3 py-3 text-right tabular-nums">{number(v)}</td>)}</tr>)}</tbody>
          </table>
        </div>}
        <p className="mt-3 text-xs leading-5 text-[#526b7d]">Staff counts across entries: <strong>{number(t.staffMembers)}</strong>. This is the sum of reported monthly counts, not a count of unique staff members.</p>
      </section>
      <footer className="mt-9 flex flex-wrap items-center justify-between gap-2 border-t border-[#dce7ef] pt-4 text-xs text-[#607889]"><span className="break-all">{company} · HPP Reporting</span><span>{period.label} · Current generated values · Typeface: Roboto (embedded in PDF)</span></footer>
    </div>
  </article>;
}

export function ExecutiveReportPreview({ report, canEdit, csrf, onClose }: { report: ReportInfo; canEdit: boolean; csrf: string | null; onClose: () => void }) {
  const { brand } = useBranding();
  const returnFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [data, setData] = useState<ExecutiveData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [emailOpen, setEmailOpen] = useState(false);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [recipient, setRecipient] = useState("");
  const [recipientLoading, setRecipientLoading] = useState(false);
  const [recipientError, setRecipientError] = useState("");
  const [recipientAttempt, setRecipientAttempt] = useState(0);
  const [sending, setSending] = useState(false);
  const [emailResult, setEmailResult] = useState<{ ok: boolean; text: string } | null>(null);
  const path = `/api/v1/reports/${encodeURIComponent(report.id)}`;

  useEffect(() => {
    const controller = new AbortController();
    setData(null); setLoadError(""); setLoading(true);
    (async () => {
      try {
        const res = await fetch(`${path}/executive`, { signal: controller.signal });
        if (!res.ok) throw new Error(await errorText(res, "Could not load the report"));
        const payload: ExecutiveData = await res.json();
        if (!payload.report || !payload.period || !payload.totals || !Array.isArray(payload.monthly)) throw new Error("The report response was incomplete.");
        if (!controller.signal.aborted) setData(payload);
      } catch (e) {
        if (!controller.signal.aborted) setLoadError(e instanceof Error ? e.message : "Could not load the report.");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [path, attempt]);

  useEffect(() => {
    if (!emailOpen || !canEdit || data?.report.status !== "published") return;
    const controller = new AbortController();
    setRecipients([]); setRecipient(""); setRecipientError(""); setRecipientLoading(true);
    (async () => {
      try {
        const res = await fetch(`${path}/recipients`, { signal: controller.signal });
        if (!res.ok) throw new Error(await errorText(res, "Could not load recipients"));
        const payload = await res.json();
        if (!Array.isArray(payload.users)) throw new Error("The recipient response was incomplete.");
        if (!controller.signal.aborted) setRecipients(payload.users);
      } catch (e) {
        if (!controller.signal.aborted) setRecipientError(e instanceof Error ? e.message : "Could not load recipients.");
      } finally { if (!controller.signal.aborted) setRecipientLoading(false); }
    })();
    return () => controller.abort();
  }, [emailOpen, canEdit, data?.report.status, path, recipientAttempt]);

  const download = async () => {
    setDownloadBusy(true); setDownloadError("");
    try {
      const res = await fetch(`${path}/pdf`);
      if (!res.ok) throw new Error(await errorText(res, "Could not download the PDF"));
      if (!res.headers.get("content-type")?.toLowerCase().includes("application/pdf")) throw new Error("The server did not return a PDF. Please try again.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url;
      a.download = `${report.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80) || "report"}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setDownloadError(e instanceof Error ? e.message : "Could not download the PDF."); }
    finally { setDownloadBusy(false); }
  };

  const sendEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!recipient || sending || !recipients.some(u => u.id === recipient)) return;
    setSending(true); setEmailResult(null);
    try {
      const res = await fetch(`${path}/email`, { method: "POST", headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) }, body: JSON.stringify({ recipientUserId: recipient }) });
      if (!res.ok) throw new Error(await errorText(res, "Email status"));
      const result = await res.json();
      if (result.ok !== true) throw new Error(typeof result.error === "string" ? result.error : "Email could not be sent.");
      setEmailResult({ ok: true, text: result.status === "simulated" ? "Simulation only — no email was sent." : `Email accepted${typeof result.provider === "string" && result.provider ? ` by ${result.provider}` : ""}. Delivery is not guaranteed.` });
    } catch (e) { setEmailResult({ ok: false, text: e instanceof TypeError ? "Could not confirm whether the report was accepted. Verify with the recipient or provider before retrying." : e instanceof Error ? e.message : "Could not confirm whether the report was accepted. Verify before retrying." }); }
    finally { setSending(false); }
  };

  const { logo: safeLogo, company, primary, secondary } = previewReportBrand(brand);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent showCloseButton={false} onCloseAutoFocus={e => { e.preventDefault(); returnFocus.current?.focus(); }} className="flex max-h-[94dvh] w-[calc(100%-1rem)] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden rounded-2xl border-border bg-background p-0 sm:max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
        <div className="min-w-0"><DialogTitle className="flex items-center gap-2 text-base"><FileText size={18} className="shrink-0" style={{ color: primary }} /> Executive report preview</DialogTitle><DialogDescription className="mt-1 text-xs">{report.title} · Generated from current metric data</DialogDescription></div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={download} disabled={downloadBusy} className="focus-ring inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-xs font-bold disabled:opacity-60" style={{ backgroundColor: primary, color: contrastText(primary) }}><Download size={15} /> {downloadBusy ? "Preparing…" : "Download PDF"}</button>
          {canEdit && data?.report.status === "published" && <button type="button" onClick={() => { setEmailOpen(v => !v); setEmailResult(null); }} aria-expanded={emailOpen} aria-controls="report-email-panel" className="focus-ring inline-flex min-h-10 items-center gap-2 rounded-lg border border-border bg-card px-3 text-xs font-bold text-foreground hover:bg-muted"><Mail size={15} /> Email report</button>}
          <button type="button" onClick={onClose} aria-label="Close report preview" className="focus-ring inline-flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-card text-foreground hover:bg-muted"><X size={18} /></button>
        </div>
      </div>
      {downloadError && <div role="alert" className="mx-4 mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-700 dark:text-rose-300">{downloadError}</div>}
      {emailOpen && canEdit && data?.report.status === "published" && <form id="report-email-panel" onSubmit={sendEmail} className="border-b border-border bg-card px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-end gap-3"><label className="min-w-[min(100%,16rem)] flex-1 text-xs font-semibold text-foreground">Eligible recipient
          <select required value={recipient} onChange={e => { setRecipient(e.target.value); setEmailResult(null); }} disabled={recipientLoading || !!recipientError || sending} className="focus-ring mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground disabled:opacity-60"><option value="">{recipientLoading ? "Loading recipients…" : "Select a recipient"}</option>{recipients.map(u => <option key={u.id} value={u.id}>{u.display_name} ({u.email})</option>)}</select></label>
          <button type="submit" disabled={!recipient || recipientLoading || sending} className="focus-ring inline-flex min-h-10 items-center gap-2 rounded-lg px-4 text-xs font-bold disabled:opacity-60" style={{ backgroundColor: primary, color: contrastText(primary) }}><Mail size={14} /> {sending ? "Sending…" : "Send email"}</button></div>
        <p className="mt-2 text-xs text-muted-foreground">The recipient must be eligible to view this published report. The email uses current generated report data.</p>
        {recipientError && <p role="alert" className="mt-2 text-xs text-rose-700 dark:text-rose-300">{recipientError} <button type="button" onClick={() => setRecipientAttempt(v => v + 1)} className="font-bold underline">Retry</button></p>}
        {!recipientLoading && !recipientError && recipients.length === 0 && <p className="mt-2 text-xs text-muted-foreground">No eligible recipients are available.</p>}
        {emailResult && <p role={emailResult.ok ? "status" : "alert"} className={`mt-2 flex items-center gap-1.5 text-xs ${emailResult.ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>{emailResult.ok ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />} {emailResult.text}</p>}
      </form>}
      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/60 p-3 sm:p-6">
        {loading ? <p role="status" className="p-8 text-center text-sm text-muted-foreground">Loading report data…</p> : loadError ? <div role="alert" className="mx-auto max-w-lg rounded-xl border border-border bg-card p-6 text-center text-sm"><p>{loadError}</p><button type="button" onClick={() => setAttempt(v => v + 1)} className="focus-ring mt-4 rounded-lg border border-border px-4 py-2 text-xs font-bold hover:bg-muted">Try again</button></div> : data ? <ExecutivePage data={data} logo={safeLogo} company={company} primary={primary} secondary={secondary} /> : null}
      </div>
    </DialogContent>
  </Dialog>;
}
