import React, { useState, useEffect, useMemo } from "react";
import { Link } from "wouter";
import { useAuth } from "../contexts/AuthContext";
import {
  Save,
  CheckCircle,
  AlertCircle,
  FileSpreadsheet,
  Download,
  Calendar,
  PenSquare,
  Sparkles,
} from "lucide-react";

const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

interface MetricForm {
  reporting_year: number;
  reporting_month: number;
  calls_round1: number;
  calls_round2: number;
  calls_round3: number;
  aca_yes: number;
  aca_no: number;
  head_of_household: number;
  staff_members: number;
  calls_jhpp: number;
  calls_wr: number;
  notes: string;
}

const emptyForm: MetricForm = {
  reporting_year: new Date().getUTCFullYear(),
  reporting_month: new Date().getUTCMonth() + 1,
  calls_round1: 0,
  calls_round2: 0,
  calls_round3: 0,
  aca_yes: 0,
  aca_no: 0,
  head_of_household: 0,
  staff_members: 0,
  calls_jhpp: 0,
  calls_wr: 0,
  notes: "",
};

export function MetricsEntryPage() {
  const { csrf } = useAuth();
  const [form, setForm] = useState<MetricForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [csvText, setCsvText] = useState("");
  const [importResult, setImportResult] = useState<{ imported: number; errors: { row: number; error: string }[] } | null>(null);

  // Load existing data for selected year/month if it exists
  useEffect(() => {
    fetch(`/api/v1/metrics/${form.reporting_year}/${form.reporting_month}`)
      .then(r => r.ok ? r.json() : null)
      .then(m => {
        if (m) {
          setForm(prev => ({
            ...prev,
            calls_round1: m.calls_round1,
            calls_round2: m.calls_round2,
            calls_round3: m.calls_round3,
            aca_yes: m.aca_yes,
            aca_no: m.aca_no,
            head_of_household: m.head_of_household,
            staff_members: m.staff_members,
            calls_jhpp: m.calls_jhpp,
            calls_wr: m.calls_wr,
            notes: m.notes || "",
          }));
        }
      });
  }, [form.reporting_year, form.reporting_month]);

  const num = (v: number) => (isNaN(v) || v < 0 ? 0 : v);
  const setField = (k: keyof MetricForm, v: unknown) => setForm(prev => ({ ...prev, [k]: v }));

  // Live computed KPIs preview
  const preview = useMemo(() => {
    const totalCalls = num(form.calls_round1) + num(form.calls_round2) + num(form.calls_round3);
    const totalAca = num(form.aca_yes) + num(form.aca_no);
    const totalReferrals = num(form.calls_jhpp) + num(form.calls_wr);
    return {
      totalCalls,
      round1Rate: totalCalls ? Math.round((form.calls_round1 / totalCalls) * 1000) / 10 : 0,
      round2Rate: totalCalls ? Math.round((form.calls_round2 / totalCalls) * 1000) / 10 : 0,
      round3Rate: totalCalls ? Math.round((form.calls_round3 / totalCalls) * 1000) / 10 : 0,
      totalAca,
      acaRate: totalAca ? Math.round((form.aca_yes / totalAca) * 1000) / 10 : 0,
      callsPerStaff: form.staff_members ? Math.round((totalCalls / form.staff_members) * 10) / 10 : 0,
      totalReferrals,
      jhppShare: totalReferrals ? Math.round((form.calls_jhpp / totalReferrals) * 1000) / 10 : 0,
      wrShare: totalReferrals ? Math.round((form.calls_wr / totalReferrals) * 1000) / 10 : 0,
    };
  }, [form]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/v1/metrics/${form.reporting_year}/${form.reporting_month}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      setMessage({ type: "ok", text: `Saved ${FULL_MONTHS[form.reporting_month - 1]} ${form.reporting_year}: ${data.kpis?.totalCalls?.toLocaleString() || ""} total calls recorded.` });
    } catch (err) {
      setMessage({ type: "err", text: String(err) });
    } finally {
      setSaving(false);
    }
  };

  const importCsv = async () => {
    setImportResult(null);
    const res = await fetch("/api/v1/metrics/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: JSON.stringify({ csv: csvText }),
    });
    const data = await res.json();
    if (res.ok) {
      setImportResult(data);
      setCsvText("");
    } else {
      setImportResult({ imported: 0, errors: [{ row: 0, error: data.error }] });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Manual Metric Entry</h1>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#5A92C9]/15 text-[#5A92C9] border border-[#5A92C9]/30">Module 3</span>
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
            Record the nine required HPP outreach metrics for any reporting month. Existing months are updated in place.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/api/v1/metrics/export"
            className="touch-target inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl border border-border bg-card hover:bg-muted focus-ring text-foreground"
          >
            <Download size={13} /> Export all as CSV
          </a>
          <Link
            href="/"
            className="touch-target inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] focus-ring"
          >
            ← View dashboard
          </Link>
        </div>
      </div>

      <form onSubmit={save} className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: form fields */}
        <div className="lg:col-span-2 space-y-5">
          {/* Period selector */}
          <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
            <h2 className="text-sm font-bold tracking-tight flex items-center gap-2">
              <Calendar size={16} className="text-[#5A92C9]" /> Reporting period
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block text-xs font-semibold">
                Reporting Month (Jan – Dec)
                <select
                  value={form.reporting_month}
                  onChange={e => setField("reporting_month", Number(e.target.value))}
                  className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background text-foreground font-semibold focus-ring"
                >
                  {FULL_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
              </label>
              <label className="block text-xs font-semibold">
                Reporting Year
                <input
                  type="number"
                  min={2000}
                  max={2100}
                  value={form.reporting_year}
                  onChange={e => setField("reporting_year", Number(e.target.value))}
                  className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background text-foreground font-semibold focus-ring"
                  required
                />
              </label>
            </div>
          </section>

          {/* Call rounds */}
          <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
            <div>
              <h2 className="text-sm font-bold tracking-tight">Calls completed by round</h2>
              <p className="text-xs text-muted-foreground">Number of calls completed in each sequential contact round</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <label className="block text-xs font-semibold">
                Calls completed in the 1st round
                <input
                  type="number"
                  min={0}
                  value={form.calls_round1}
                  onChange={e => setField("calls_round1", Math.max(0, Number(e.target.value)))}
                  className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background text-foreground text-right font-bold focus-ring"
                  required
                />
              </label>
              <label className="block text-xs font-semibold">
                Calls completed in the 2nd round
                <input
                  type="number"
                  min={0}
                  value={form.calls_round2}
                  onChange={e => setField("calls_round2", Math.max(0, Number(e.target.value)))}
                  className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background text-foreground text-right font-bold focus-ring"
                  required
                />
              </label>
              <label className="block text-xs font-semibold">
                Calls completed in the 3rd round
                <input
                  type="number"
                  min={0}
                  value={form.calls_round3}
                  onChange={e => setField("calls_round3", Math.max(0, Number(e.target.value)))}
                  className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background text-foreground text-right font-bold focus-ring"
                  required
                />
              </label>
            </div>
          </section>

          {/* ACA disposition */}
          <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
            <div>
              <h2 className="text-sm font-bold tracking-tight">ACA response disposition</h2>
              <p className="text-xs text-muted-foreground">Member willingness to participate in ACA health-plan outreach</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block text-xs font-semibold text-emerald-500">
                ACA YES
                <input
                  type="number"
                  min={0}
                  value={form.aca_yes}
                  onChange={e => setField("aca_yes", Math.max(0, Number(e.target.value)))}
                  className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background text-foreground text-right font-bold focus-ring"
                  required
                />
              </label>
              <label className="block text-xs font-semibold">
                ACA No
                <input
                  type="number"
                  min={0}
                  value={form.aca_no}
                  onChange={e => setField("aca_no", Math.max(0, Number(e.target.value)))}
                  className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background text-foreground text-right font-bold focus-ring"
                  required
                />
              </label>
            </div>
          </section>

          {/* Household & staffing */}
          <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
            <div>
              <h2 className="text-sm font-bold tracking-tight">Household & staffing</h2>
              <p className="text-xs text-muted-foreground">Head-of-household contacts and active caller capacity</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block text-xs font-semibold">
                Head of Household
                <input
                  type="number"
                  min={0}
                  value={form.head_of_household}
                  onChange={e => setField("head_of_household", Math.max(0, Number(e.target.value)))}
                  className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background text-foreground text-right font-bold focus-ring"
                  required
                />
              </label>
              <label className="block text-xs font-semibold">
                Staff Members making calls
                <input
                  type="number"
                  min={0}
                  value={form.staff_members}
                  onChange={e => setField("staff_members", Math.max(0, Number(e.target.value)))}
                  className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background text-foreground text-right font-bold focus-ring"
                  required
                />
              </label>
            </div>
          </section>

          {/* Referrals */}
          <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
            <div>
              <h2 className="text-sm font-bold tracking-tight">Referrals destination</h2>
              <p className="text-xs text-muted-foreground">Calls referred out to JHPP and WR programs</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block text-xs font-semibold">
                Calls referred to JHPP
                <input
                  type="number"
                  min={0}
                  value={form.calls_jhpp}
                  onChange={e => setField("calls_jhpp", Math.max(0, Number(e.target.value)))}
                  className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background text-foreground text-right font-bold focus-ring"
                  required
                />
              </label>
              <label className="block text-xs font-semibold">
                Calls referred to WR
                <input
                  type="number"
                  min={0}
                  value={form.calls_wr}
                  onChange={e => setField("calls_wr", Math.max(0, Number(e.target.value)))}
                  className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background text-foreground text-right font-bold focus-ring"
                  required
                />
              </label>
            </div>
          </section>

          {/* Notes */}
          <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-2">
            <label className="block text-xs font-semibold">
              Notes / context (optional)
              <textarea
                value={form.notes}
                onChange={e => setField("notes", e.target.value)}
                maxLength={2000}
                rows={2}
                placeholder="Campaign context, staffing notes, data sources..."
                className="mt-1 w-full px-3 py-2 rounded-xl border border-border bg-background text-foreground text-xs focus-ring"
              />
            </label>
          </section>

          {message && (
            <div className={`p-3 rounded-xl text-xs flex items-center gap-2 ${message.type === "ok" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30" : "bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30"}`}>
              {message.type === "ok" ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
              {message.text}
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="touch-target inline-flex items-center gap-2 px-5 py-2 text-sm font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] disabled:opacity-50 focus-ring"
            >
              <Save size={15} /> {saving ? "Saving…" : `Save ${FULL_MONTHS[form.reporting_month - 1]} ${form.reporting_year}`}
            </button>
            <button
              type="button"
              onClick={() => setForm(emptyForm)}
              className="touch-target px-4 py-2 text-xs font-semibold rounded-xl border border-border bg-card hover:bg-muted text-muted-foreground hover:text-foreground focus-ring"
            >
              Reset
            </button>
          </div>
        </div>

        {/* Right: computed preview */}
        <div className="space-y-4">
          <aside className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4 lg:sticky lg:top-20">
            <h2 className="text-sm font-bold tracking-tight flex items-center gap-2">
              <Sparkles size={16} className="text-[#D58240]" /> Computed summary (live)
            </h2>
            <div className="space-y-3 text-xs">
              <div className="flex justify-between py-1 border-b border-border">
                <span className="text-muted-foreground">Total calls (R1+R2+R3)</span>
                <span className="font-bold text-foreground">{preview.totalCalls.toLocaleString()}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-border">
                <span className="text-muted-foreground">Round 1 share</span>
                <span className="font-semibold">{preview.round1Rate}%</span>
              </div>
              <div className="flex justify-between py-1 border-b border-border">
                <span className="text-muted-foreground">Round 2 share</span>
                <span className="font-semibold">{preview.round2Rate}%</span>
              </div>
              <div className="flex justify-between py-1 border-b border-border">
                <span className="text-muted-foreground">Round 3 share</span>
                <span className="font-semibold">{preview.round3Rate}%</span>
              </div>
              <div className="flex justify-between py-1 border-b border-border">
                <span className="text-muted-foreground">Total ACA responses</span>
                <span className="font-semibold">{preview.totalAca.toLocaleString()}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-border">
                <span className="text-muted-foreground">ACA YES rate</span>
                <span className="font-bold text-emerald-500">{preview.acaRate}%</span>
              </div>
              <div className="flex justify-between py-1 border-b border-border">
                <span className="text-muted-foreground">Calls per staff</span>
                <span className="font-semibold">{preview.callsPerStaff}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-border">
                <span className="text-muted-foreground">Total referrals</span>
                <span className="font-bold text-foreground">{preview.totalReferrals.toLocaleString()}</span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-muted-foreground">JHPP / WR split</span>
                <span className="font-semibold">{preview.jhppShare}% / {preview.wrShare}%</span>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              These computed KPIs mirror the dashboard — changes take effect immediately on save.
            </p>
          </aside>

          {/* Bulk CSV import */}
          <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-3">
            <h2 className="text-sm font-bold tracking-tight flex items-center gap-2">
              <FileSpreadsheet size={16} className="text-[#5A92C9]" /> Bulk CSV import
            </h2>
            <p className="text-[11px] text-muted-foreground">
              Paste CSV with headers matching the nine metrics (e.g. "Reporting Year,Reporting Month,Calls round 1,..."). Existing months are updated.
            </p>
            <textarea
              value={csvText}
              onChange={e => setCsvText(e.target.value)}
              rows={4}
              placeholder={`Reporting Year,Reporting Month,Calls round 1,Calls round 2,Calls round 3,ACA YES,ACA No,Head of Household,Staff members making calls,Calls referred to JHPP,Calls referred to WR,Notes
2026,1,412,189,94,287,145,178,9,134,98,January campaign`}
              className="w-full px-3 py-2 rounded-xl border border-border bg-background text-foreground text-[11px] font-mono focus-ring"
            />
            <button
              type="button"
              onClick={importCsv}
              disabled={!csvText.trim()}
              className="touch-target w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-bold rounded-xl border border-border bg-card hover:bg-muted disabled:opacity-40 focus-ring"
            >
              Import rows
            </button>
            {importResult && (
              <div className="text-xs space-y-1">
                <div className="font-semibold text-emerald-500">Imported: {importResult.imported} row(s)</div>
                {importResult.errors.map(err => (
                  <div key={err.row + err.error} className="text-rose-500">
                    Row {err.row}: {err.error}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </form>
    </div>
  );
}
