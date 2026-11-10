import React, { useState, useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import {
  FileText,
  Plus,
  Eye,
  EyeOff,
  Send,
  Trash2,
  Calendar,
  User,
  Layers,
  Search,
  Filter,
  Download,
  AlertCircle,
  CheckCircle,
  Edit3,
} from "lucide-react";

const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

interface Report {
  id: string;
  title: string;
  description: string | null;
  reporting_year: number | null;
  reporting_month: number | null;
  status: "draft" | "published" | "hidden";
  version: number;
  publish_target: "all" | "specific_users" | "view_users";
  published_at: string | null;
  created_at: string;
  creator_name?: string;
  assignments?: string[];
  layout_config?: Record<string, unknown>;
}

export function ReportsPage() {
  const { csrf, isSuperAdmin, isAdmin, isManager, isViewOnly } = useAuth();
  const canEdit = isSuperAdmin || isAdmin || isManager;
  const canDelete = isSuperAdmin || isAdmin;

  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [publishTargetModal, setPublishTargetModal] = useState<Report | null>(null);
  const [targetType, setTargetType] = useState<"all" | "specific_users" | "view_users">("all");
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [viewUsersList, setViewUsersList] = useState<{ id: string; display_name: string; email: string; role: string }[]>([]);
  const [previewReport, setPreviewReport] = useState<Report | null>(null);
  const [previewData, setPreviewData] = useState<any>(null);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // Form state
  const [form, setForm] = useState({
    title: "",
    description: "",
    reporting_year: new Date().getUTCFullYear(),
    reporting_month: 0,
    widgets: ["kpi_cards", "calls_by_round", "aca_breakdown", "referrals", "trend", "table"],
  });
  const [editId, setEditId] = useState<string | null>(null);

  const fetchReports = async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (statusFilter !== "all") p.set("status", statusFilter);
      if (search) p.set("search", search);
      const res = await fetch(`/api/v1/reports?${p}`);
      if (res.ok) {
        const data = await res.json();
        setReports(data.reports);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchReports(); }, [statusFilter, search]);

  const loadViewUsers = async () => {
    if (!canEdit) return;
    try {
      const res = await fetch("/api/v1/admin/users");
      if (res.ok) {
        const d = await res.json();
        setViewUsersList((d.users || []).filter((u: any) => u.role === "view_only"));
      }
    } catch {}
  };

  const saveReport = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = {
      title: form.title,
      description: form.description || undefined,
      reporting_year: form.reporting_year ? Number(form.reporting_year) : undefined,
      reporting_month: form.reporting_month ? Number(form.reporting_month) : undefined,
      layout_config: { widgets: form.widgets },
    };
    const url = editId ? `/api/v1/admin/reports/${editId}` : "/api/v1/admin/reports";
    const method = editId ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      setCreateOpen(false);
      setEditId(null);
      setMessage({ type: "ok", text: editId ? "Report updated (version incremented)." : "Draft report created." });
      fetchReports();
    } else {
      setMessage({ type: "err", text: "Save failed" });
    }
  };

  const startEdit = (r: Report) => {
    setForm({
      title: r.title,
      description: r.description || "",
      reporting_year: r.reporting_year || new Date().getUTCFullYear(),
      reporting_month: r.reporting_month || 0,
      widgets: Array.isArray((r.layout_config as any)?.widgets) ? (r.layout_config as any).widgets : ["kpi_cards", "trend", "table"],
    });
    setEditId(r.id);
    setCreateOpen(true);
  };

  const openPublishModal = async (r: Report) => {
    setPublishTargetModal(r);
    setTargetType(r.publish_target || "all");
    setSelectedUsers(r.assignments || []);
    await loadViewUsers();
  };

  const confirmPublish = async () => {
    if (!publishTargetModal) return;
    const res = await fetch(`/api/v1/admin/reports/${publishTargetModal.id}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: JSON.stringify({ target: targetType, userIds: targetType === "specific_users" ? selectedUsers : undefined }),
    });
    if (res.ok) {
      setMessage({ type: "ok", text: "Report published." });
      setPublishTargetModal(null);
      fetchReports();
    }
  };

  const hide = async (id: string) => {
    const res = await fetch(`/api/v1/admin/reports/${id}/hide`, {
      method: "POST",
      headers: { ...(csrf ? { "x-csrf-token": csrf } : {}) },
    });
    if (res.ok) {
      setMessage({ type: "ok", text: "Report hidden (draft)." });
      fetchReports();
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this report permanently?")) return;
    const res = await fetch(`/api/v1/admin/reports/${id}`, {
      method: "DELETE",
      headers: { ...(csrf ? { "x-csrf-token": csrf } : {}) },
    });
    if (res.ok) fetchReports();
  };

  const openPreview = async (r: Report) => {
    setPreviewReport(r);
    const yr = r.reporting_year || new Date().getUTCFullYear();
    const res = await fetch(`/api/v1/dashboard/summary?year=${yr}`);
    if (res.ok) setPreviewData(await res.json());
  };

  const statusColor: Record<string, string> = {
    draft: "bg-slate-500/15 text-slate-500 border-slate-500/30",
    published: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/30",
    hidden: "bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30",
  };

  const targetLabel: Record<string, string> = {
    all: "Everyone",
    specific_users: "Specific users",
    view_users: "View Users",
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Report Center</h1>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#5A92C9]/15 text-[#5A92C9] border border-[#5A92C9]/30">Module 3</span>
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
            Admins and managers create manual reports, preview them, and publish to everyone, specific users, or specifically for View Users — or hide reports anytime.
          </p>
        </div>
        {canEdit && (
          <button
            onClick={() => { setForm({ title: "", description: "", reporting_year: new Date().getUTCFullYear(), reporting_month: 0, widgets: ["kpi_cards", "calls_by_round", "aca_breakdown", "referrals", "trend", "table"] }); setEditId(null); setCreateOpen(true); }}
            className="touch-target inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] focus-ring"
          >
            <Plus size={14} /> Create report
          </button>
        )}
      </div>

      {message && (
        <div className={`p-3 rounded-xl text-xs flex items-center gap-2 ${message.type === "ok" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30" : "bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30"}`}>
          {message.type === "ok" ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          {message.text}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2 text-xs">
        <div className="flex items-center gap-1 overflow-x-auto pb-1">
          {["all", "published", "draft", "hidden"].map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1 rounded-full font-semibold capitalize whitespace-nowrap focus-ring ${statusFilter === s ? "bg-[#5A92C9] text-white" : "bg-card border border-border text-muted-foreground hover:text-foreground"}`}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="relative sm:ml-auto sm:w-64">
          <Search size={14} className="absolute left-3 top-2.5 text-muted-foreground" />
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search reports…"
            className="w-full h-8 pl-8 pr-3 rounded-full border border-border bg-card text-xs focus-ring"
          />
        </div>
      </div>

      {/* Report cards */}
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading reports…</p>
      ) : reports.length === 0 ? (
        <div className="rounded-2xl bg-card border border-border p-12 text-center text-xs text-muted-foreground">
          No reports match the current filter.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {reports.map(r => (
            <article key={r.id} className="rounded-2xl bg-card border border-border p-5 panel-shadow flex flex-col justify-between gap-4">
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="text-sm font-bold tracking-tight text-foreground line-clamp-2">{r.title}</h2>
                  <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border shrink-0 ${statusColor[r.status]}`}>
                    {r.status}
                  </span>
                </div>
                {r.description && <p className="text-xs text-muted-foreground line-clamp-3">{r.description}</p>}
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground pt-1">
                  <span className="flex items-center gap-1">
                    <Calendar size={12} />
                    {r.reporting_month ? `${FULL_MONTHS[r.reporting_month - 1]} ` : ""}{r.reporting_year || "All periods"}
                  </span>
                  <span>·</span>
                  <span className="flex items-center gap-1"><Layers size={12} /> v{r.version}</span>
                  {r.creator_name && (
                    <>
                      <span>·</span>
                      <span className="flex items-center gap-1"><User size={12} /> {r.creator_name}</span>
                    </>
                  )}
                </div>
                {r.status === "published" && (
                  <p className="text-[11px] text-emerald-500 font-semibold">
                    Published to: {targetLabel[r.publish_target]} · {r.published_at ? new Date(r.published_at).toLocaleDateString() : ""}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border text-xs">
                <button
                  onClick={() => openPreview(r)}
                  className="touch-target inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border bg-card hover:bg-muted font-semibold focus-ring"
                >
                  <Eye size={13} /> Preview
                </button>
                <a
                  href={`/api/v1/reports/${r.id}/export`}
                  className="touch-target inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border bg-card hover:bg-muted font-semibold focus-ring text-foreground"
                >
                  <Download size={13} /> JSON
                </a>
                {canEdit && (
                  <>
                    <button
                      onClick={() => startEdit(r)}
                      className="touch-target inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border bg-card hover:bg-muted font-semibold focus-ring"
                    >
                      <Edit3 size={13} /> Edit
                    </button>
                    {r.status !== "published" ? (
                      <button
                        onClick={() => openPublishModal(r)}
                        className="touch-target inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#5A92C9] text-white hover:bg-[#4a80b3] font-semibold focus-ring"
                      >
                        <Send size={13} /> Publish
                      </button>
                    ) : (
                      <button
                        onClick={() => hide(r.id)}
                        className="touch-target inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border bg-card hover:bg-muted font-semibold text-amber-500 focus-ring"
                      >
                        <EyeOff size={13} /> Hide
                      </button>
                    )}
                  </>
                )}
                {canDelete && (
                  <button
                    onClick={() => remove(r.id)}
                    className="touch-target inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border bg-card hover:bg-rose-500/10 font-semibold text-rose-500 ml-auto focus-ring"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {/* Create / Edit modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <form onSubmit={saveReport} className="w-full max-w-lg rounded-2xl bg-card border border-border p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-base font-bold">{editId ? "Edit report (version will increment)" : "Create report"}</h2>
            <label className="block text-xs font-semibold">
              Title
              <input
                type="text"
                required
                minLength={3}
                maxLength={180}
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background text-xs font-semibold focus-ring"
                placeholder="e.g. Q4 2026 Outreach Performance Review"
              />
            </label>
            <label className="block text-xs font-semibold">
              Description
              <textarea
                rows={3}
                maxLength={2000}
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                className="mt-1 w-full px-3 py-2 rounded-xl border border-border bg-background text-xs focus-ring"
                placeholder="Executive context, purpose, notes..."
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs font-semibold">
                Reporting year
                <input
                  type="number"
                  min={2000}
                  max={2100}
                  value={form.reporting_year}
                  onChange={e => setForm(f => ({ ...f, reporting_year: Number(e.target.value) }))}
                  className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background text-xs font-semibold focus-ring"
                />
              </label>
              <label className="block text-xs font-semibold">
                Month (0 = full year)
                <select
                  value={form.reporting_month}
                  onChange={e => setForm(f => ({ ...f, reporting_month: Number(e.target.value) }))}
                  className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background text-xs font-semibold focus-ring"
                >
                  <option value={0}>Full year</option>
                  {FULL_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
              </label>
            </div>
            <div>
              <p className="text-xs font-semibold mb-1">Included widgets</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {[
                  { id: "kpi_cards", label: "KPI cards" },
                  { id: "calls_by_round", label: "Calls by round" },
                  { id: "aca_breakdown", label: "ACA response mix" },
                  { id: "referrals", label: "Referrals split" },
                  { id: "trend", label: "Monthly trend lines" },
                  { id: "table", label: "Monthly history table" },
                ].map(w => (
                  <label key={w.id} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.widgets.includes(w.id)}
                      onChange={e => setForm(f => ({ ...f, widgets: e.target.checked ? [...f.widgets, w.id] : f.widgets.filter(x => x !== w.id) }))}
                    />
                    <span>{w.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="touch-target px-4 py-2 text-xs font-semibold rounded-xl border border-border bg-card hover:bg-muted focus-ring"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="touch-target px-4 py-2 text-xs font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] focus-ring"
              >
                {editId ? "Save changes" : "Create draft"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Publish target modal */}
      {publishTargetModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-card border border-border p-6 shadow-2xl space-y-4">
            <h2 className="text-base font-bold">Publish «{publishTargetModal.title}»</h2>
            <p className="text-xs text-muted-foreground">
              Choose who can see this report. View Only users only see reports explicitly published to them.
            </p>
            <div className="space-y-2 text-xs">
              <label className="flex items-start gap-2 cursor-pointer p-2 rounded-xl border border-border hover:bg-muted/40">
                <input
                  type="radio"
                  name="tgt"
                  checked={targetType === "all"}
                  onChange={() => setTargetType("all")}
                  className="mt-0.5"
                />
                <div>
                  <div className="font-semibold">Everyone</div>
                  <div className="text-muted-foreground text-[11px]">All signed-in users (all roles) can view</div>
                </div>
              </label>
              <label className="flex items-start gap-2 cursor-pointer p-2 rounded-xl border border-border hover:bg-muted/40">
                <input
                  type="radio"
                  name="tgt"
                  checked={targetType === "view_users"}
                  onChange={() => setTargetType("view_users")}
                  className="mt-0.5"
                />
                <div>
                  <div className="font-semibold">View Users</div>
                  <div className="text-muted-foreground text-[11px]">Published specifically for the View Only role</div>
                </div>
              </label>
              <label className="flex items-start gap-2 cursor-pointer p-2 rounded-xl border border-border hover:bg-muted/40">
                <input
                  type="radio"
                  name="tgt"
                  checked={targetType === "specific_users"}
                  onChange={() => setTargetType("specific_users")}
                  className="mt-0.5"
                />
                <div className="flex-1">
                  <div className="font-semibold">Specific users</div>
                  <div className="text-muted-foreground text-[11px]">Pick exactly which View Only users may see this report</div>
                </div>
              </label>
            </div>

            {targetType === "specific_users" && (
              <div className="max-h-48 overflow-y-auto border border-border rounded-xl p-2 space-y-1 text-xs">
                {viewUsersList.length === 0 ? (
                  <p className="text-muted-foreground text-[11px] p-2">No View Only users exist yet.</p>
                ) : (
                  viewUsersList.map(u => (
                    <label key={u.id} className="flex items-center gap-2 p-1.5 rounded hover:bg-muted/40 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedUsers.includes(u.id)}
                        onChange={e => setSelectedUsers(s => e.target.checked ? [...s, u.id] : s.filter(x => x !== u.id))}
                      />
                      <span className="font-semibold">{u.display_name}</span>
                      <span className="text-muted-foreground text-[11px]">({u.email})</span>
                    </label>
                  ))
                )}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPublishTargetModal(null)}
                className="touch-target px-4 py-2 text-xs font-semibold rounded-xl border border-border bg-card hover:bg-muted focus-ring"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmPublish}
                className="touch-target px-4 py-2 text-xs font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] focus-ring"
              >
                Publish now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview modal */}
      {previewReport && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-4xl rounded-2xl bg-card border border-border p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-lg font-bold">{previewReport.title}</h2>
                {previewReport.description && <p className="text-xs text-muted-foreground mt-1">{previewReport.description}</p>}
                <p className="text-[11px] text-muted-foreground mt-1">
                  {previewReport.reporting_month ? `${FULL_MONTHS[previewReport.reporting_month - 1]} ` : ""}{previewReport.reporting_year || "Full year"} · v{previewReport.version} · {previewReport.status}
                </p>
              </div>
              <button
                onClick={() => setPreviewReport(null)}
                className="touch-target px-3 py-1.5 text-xs font-semibold rounded-xl border border-border bg-card hover:bg-muted focus-ring"
              >
                Close
              </button>
            </div>
            {previewData && (
              <div className="text-xs space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="rounded-xl border border-border p-3"><div className="text-muted-foreground text-[11px]">Total calls</div><div className="text-xl font-bold mt-1">{previewData.totals.totalCalls.toLocaleString()}</div></div>
                  <div className="rounded-xl border border-border p-3"><div className="text-muted-foreground text-[11px]">ACA YES rate</div><div className="text-xl font-bold mt-1 text-emerald-500">{previewData.totals.acaRate}%</div></div>
                  <div className="rounded-xl border border-border p-3"><div className="text-muted-foreground text-[11px]">Head of household</div><div className="text-xl font-bold mt-1">{previewData.totals.head_of_household.toLocaleString()}</div></div>
                  <div className="rounded-xl border border-border p-3"><div className="text-muted-foreground text-[11px]">Total referrals</div><div className="text-xl font-bold mt-1">{previewData.totals.totalReferrals.toLocaleString()}</div></div>
                </div>
                <p className="text-[11px] text-muted-foreground">Snapshot rendered from current metric data.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
