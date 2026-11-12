import React, { useEffect, useRef, useState } from "react";
import { Calendar, Download, Eye, FileText, Lock } from "lucide-react";
import { ExecutiveReportPreview } from "../components/ExecutiveReportPreview";
import { useAuth } from "../contexts/AuthContext";

const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

type Report = {
  id: string;
  tenant_id: string | null;
  title: string;
  description: string | null;
  reporting_year: number | null;
  reporting_month: number | null;
  version: number;
  status: "draft" | "published" | "hidden";
};

function periodFor(report: Report) {
  const month = report.reporting_month ? FULL_MONTHS[report.reporting_month - 1] : "";
  return [month, report.reporting_year].filter(Boolean).join(" ") || "All periods";
}

function requestError(status: number, action: string) {
  if (status === 401) return `Your session may have expired. Sign in again to ${action}.`;
  if (status === 403 || status === 404) return "This report is no longer available to your account. Contact an administrator if you need access.";
  return `Unable to ${action} right now. Please try again.`;
}

export function ViewerPortalPage() {
  const { user } = useAuth();
  const [reports, setReports] = useState<Report[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [listError, setListError] = useState("");
  const [listAttempt, setListAttempt] = useState(0);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Report | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<{ id: string; text: string } | null>(null);
  const downloadBusy = useRef(false);
  const downloadController = useRef<AbortController | null>(null);
  const accountKey = user ? `${user.id}:${user.tenant_id ?? ""}` : null;

  useEffect(() => {
    downloadController.current?.abort();
    downloadController.current = null;
    downloadBusy.current = false;
    setDownloading(null);
  }, [accountKey]);

  useEffect(() => {
    const controller = new AbortController();
    setListState("loading");
    setListError("");
    setSelected(null);
    setDownloadError(null);
    setLoadedFor(null);
    if (!user || !accountKey) return () => controller.abort();
    fetch("/api/v1/reports?status=published", { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error(requestError(response.status, "load reports"));
        const result = await response.json();
        if (!Array.isArray(result.reports)) throw new Error("The report list could not be read. Please try again.");
        if (!controller.signal.aborted) {
          // Server-side authorization is essential. This also avoids showing cross-tenant
          // metadata if an older report-list endpoint returns too many rows.
          setReports(result.reports.filter((report: Report) => report.status === "published" && !!user.tenant_id && report.tenant_id === user.tenant_id));
          setLoadedFor(accountKey);
          setListState("ready");
        }
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        setReports([]);
        setLoadedFor(accountKey);
        setListError(error instanceof Error && error.message !== "Failed to fetch" ? error.message : "Unable to load reports. Check your connection and try again.");
        setListState("error");
      });
    return () => controller.abort();
  }, [listAttempt, accountKey]);

  useEffect(() => () => downloadController.current?.abort(), []);

  const downloadPdf = async (report: Report) => {
    if (downloadBusy.current) return;
    downloadBusy.current = true;
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloading(report.id);
    setDownloadError(null);
    try {
      const response = await fetch(`/api/v1/reports/${encodeURIComponent(report.id)}/pdf`, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(requestError(response.status, "download the PDF"));
      if (!response.headers.get("content-type")?.toLowerCase().includes("application/pdf")) throw new Error("The PDF could not be downloaded. Please try again or contact an administrator.");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `report-${report.id.replace(/[^a-zA-Z0-9_-]/g, "-")}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (!controller.signal.aborted) setDownloadError({ id: report.id, text: error instanceof Error && error.message !== "Failed to fetch" ? error.message : "Unable to download the PDF. Check your connection and try again." });
    } finally {
      if (downloadController.current === controller) {
        downloadController.current = null;
        downloadBusy.current = false;
        if (!controller.signal.aborted) setDownloading(null);
      }
    }
  };

  const showingCurrentAccount = loadedFor !== null && loadedFor === accountKey;
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Published Reports Portal</h1>
          <p className="text-sm text-muted-foreground mt-1">View and download reports published to your account.</p>
        </div>
        <span className="text-xs text-muted-foreground flex items-center gap-1"><Lock size={12} className="text-emerald-500" /> View-only access</span>
      </div>
      <section aria-labelledby="published-reports" className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-3">
        <h2 id="published-reports" className="text-sm font-bold tracking-tight flex items-center gap-2"><FileText size={16} className="text-[#5A92C9]" /> Published reports</h2>
        {!showingCurrentAccount || listState === "loading" ? <p role="status" className="text-sm text-muted-foreground">Loading reports…</p> : listState === "error" ? (
          <div role="alert" className="text-sm text-rose-600 dark:text-rose-300"><p>{listError}</p><button type="button" onClick={() => setListAttempt(n => n + 1)} className="mt-2 underline font-semibold focus-ring">Try again</button></div>
        ) : reports.length === 0 ? <p className="text-sm text-muted-foreground">No reports are currently published for your account.</p> : (
          <div className="divide-y divide-border">
            {reports.map(report => (
              <article key={report.id} className="py-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-bold break-words">{report.title}</h3>
                  {report.description && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{report.description}</p>}
                  <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><Calendar size={13} /> {periodFor(report)} <span>· v{report.version}</span></p>
                  {downloadError?.id === report.id && <p role="alert" className="mt-2 text-xs text-rose-600 dark:text-rose-300">{downloadError.text}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button type="button" onClick={() => setSelected(report)} className="touch-target inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border bg-card hover:bg-muted text-xs font-semibold focus-ring"><Eye size={14} /> Open report</button>
                  <button type="button" onClick={() => downloadPdf(report)} disabled={downloading !== null} className="touch-target inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#3975a6] text-white hover:bg-[#315f86] text-xs font-semibold focus-ring disabled:opacity-60"><Download size={14} /> {downloading === report.id ? "Downloading…" : "Download PDF"}</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {selected && showingCurrentAccount && <ExecutiveReportPreview key={selected.id} report={selected} canEdit={false} csrf={null} onClose={() => setSelected(null)} />}
    </div>
  );
}
