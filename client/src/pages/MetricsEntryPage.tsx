import React, { useState, useEffect, useMemo } from "react";
import { Link } from "wouter";
import { useAuth } from "../contexts/AuthContext";
import { apiFetch, apiJson, errorText } from "../lib/api";
import {
  Save,
  CheckCircle,
  AlertCircle,
  FileSpreadsheet,
  Download,
  Calendar,
  Sparkles,
} from "lucide-react";

const FULL_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

interface MetricForm {
  reporting_year: number;
  reporting_month: number;
  staff_members: number;
  total_calls: number;
  members_reached: number;
  referrals: number;
  calls_round1: number;
  calls_round2: number;
  calls_round3: number;
  aca_yes: number;
  aca_no: number;
  head_of_household: number;
  calls_jhpp: number;
  calls_wr: number;
  notes: string;
}

type CountField = Exclude<
  keyof MetricForm,
  "reporting_year" | "reporting_month" | "notes"
>;
const primaryFields: { key: CountField; label: string }[] = [
  { key: "staff_members", label: "Number of staff making the calls" },
  { key: "total_calls", label: "Total Number of Calls" },
  { key: "members_reached", label: "Total number of members REACHED" },
  { key: "referrals", label: "Number of Referrals" },
  { key: "calls_round1", label: "1st Round Completed Calls" },
  { key: "calls_round2", label: "2nd Round Completed Calls" },
  { key: "calls_round3", label: "3rd Round Completed Calls" },
];
const additionalFields: { key: CountField; label: string }[] = [
  { key: "aca_yes", label: "ACA YES" },
  { key: "aca_no", label: "ACA No" },
  { key: "head_of_household", label: "Head of Household" },
  { key: "calls_jhpp", label: "Calls referred to JHPP" },
  { key: "calls_wr", label: "Calls referred to WR" },
];
const emptyForm: MetricForm = {
  reporting_year: new Date().getUTCFullYear(),
  reporting_month: new Date().getUTCMonth() + 1,
  staff_members: 0,
  total_calls: 0,
  members_reached: 0,
  referrals: 0,
  calls_round1: 0,
  calls_round2: 0,
  calls_round3: 0,
  aca_yes: 0,
  aca_no: 0,
  head_of_household: 0,
  calls_jhpp: 0,
  calls_wr: 0,
  notes: "",
};

export function MetricsEntryPage() {
  const { csrf } = useAuth();
  const [form, setForm] = useState<MetricForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [loadingMonth, setLoadingMonth] = useState(true);
  const [monthLoadFailed, setMonthLoadFailed] = useState(false);
  const [message, setMessage] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);
  const [csvText, setCsvText] = useState("");
  const [importResult, setImportResult] = useState<{
    imported: number;
    errors: { row: number; error: string }[];
  } | null>(null);

  // Only read the selected month. A missing month remains zero until an explicit save.
  useEffect(() => {
    const controller = new AbortController();
    const reporting_year = form.reporting_year;
    const reporting_month = form.reporting_month;
    setLoadingMonth(true);
    setMonthLoadFailed(false);
    setMessage(null);
    setForm({ ...emptyForm, reporting_year, reporting_month });
    apiFetch(`/api/v1/metrics/${reporting_year}/${reporting_month}`, {
      signal: controller.signal,
    })
      .then(async response => {
        if (response.status === 404) return null;
        if (!response.ok)
          throw new Error(`Server returned ${response.status}.`);
        return response.json();
      })
      .then(m => {
        if (!m || controller.signal.aborted) return;
        setForm(prev => ({
          ...prev,
          total_calls:
            m.total_calls ??
            m.kpis?.totalCalls ??
            (m.calls_round1 ?? 0) +
              (m.calls_round2 ?? 0) +
              (m.calls_round3 ?? 0),
          members_reached: m.members_reached ?? 0,
          referrals:
            m.referrals ??
            m.kpis?.totalReferrals ??
            (m.calls_jhpp ?? 0) + (m.calls_wr ?? 0),
          calls_round1: m.calls_round1 ?? 0,
          calls_round2: m.calls_round2 ?? 0,
          calls_round3: m.calls_round3 ?? 0,
          aca_yes: m.aca_yes ?? 0,
          aca_no: m.aca_no ?? 0,
          head_of_household: m.head_of_household ?? 0,
          staff_members: m.staff_members ?? 0,
          calls_jhpp: m.calls_jhpp ?? 0,
          calls_wr: m.calls_wr ?? 0,
          notes: m.notes ?? "",
        }));
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        // Errors must not permit overwriting unread existing data.
        setMonthLoadFailed(true);
        setMessage({
          type: "err",
          text: `Could not load this reporting month. ${errorText(err)}`,
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingMonth(false);
      });
    return () => controller.abort();
  }, [form.reporting_year, form.reporting_month]);

  const num = (v: number) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const setField = (k: keyof MetricForm, v: unknown) =>
    setForm(prev => ({ ...prev, [k]: v }));
  const preview = useMemo(() => {
    const totalCalls = num(form.total_calls);
    const totalAca = num(form.aca_yes) + num(form.aca_no);
    const destinationCalls = num(form.calls_jhpp) + num(form.calls_wr);
    return {
      totalCalls,
      membersReached: num(form.members_reached),
      round1Rate: totalCalls
        ? Math.round((num(form.calls_round1) / totalCalls) * 1000) / 10
        : 0,
      round2Rate: totalCalls
        ? Math.round((num(form.calls_round2) / totalCalls) * 1000) / 10
        : 0,
      round3Rate: totalCalls
        ? Math.round((num(form.calls_round3) / totalCalls) * 1000) / 10
        : 0,
      totalAca,
      acaRate: totalAca
        ? Math.round((num(form.aca_yes) / totalAca) * 1000) / 10
        : 0,
      callsPerStaff: num(form.staff_members)
        ? Math.round((totalCalls / form.staff_members) * 10) / 10
        : 0,
      totalReferrals: num(form.referrals),
      jhppShare: destinationCalls
        ? Math.round((num(form.calls_jhpp) / destinationCalls) * 1000) / 10
        : 0,
      wrShare: destinationCalls
        ? Math.round((num(form.calls_wr) / destinationCalls) * 1000) / 10
        : 0,
    };
  }, [form]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loadingMonth || monthLoadFailed || saving) return;
    if (
      [...primaryFields, ...additionalFields].some(
        ({ key }) => !Number.isSafeInteger(form[key]) || form[key] < 0
      )
    ) {
      setMessage({
        type: "err",
        text: `Enter whole numbers from 0 to ${Number.MAX_SAFE_INTEGER} for all counts. Blank or unknown counts use 0.`,
      });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const data = await apiJson<{ kpis?: { totalCalls?: number } }>(
        `/api/v1/metrics/${form.reporting_year}/${form.reporting_month}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
          csrf,
        }
      );
      setMessage({
        type: "ok",
        text: `Saved ${FULL_MONTHS[form.reporting_month - 1]} ${form.reporting_year}: ${(data.kpis?.totalCalls ?? form.total_calls).toLocaleString()} total calls recorded.`,
      });
    } catch (err) {
      setMessage({ type: "err", text: errorText(err) });
    } finally {
      setSaving(false);
    }
  };

  const importCsv = async () => {
    setImportResult(null);
    try {
      const data = await apiJson<{
        imported: number;
        errors: { row: number; error: string }[];
      }>("/api/v1/metrics/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: csvText }),
        csrf,
      });
      setImportResult(data);
      setCsvText("");
    } catch (err) {
      setImportResult({
        imported: 0,
        errors: [{ row: 0, error: errorText(err) }],
      });
    }
  };

  const countInput = (
    { key, label }: { key: CountField; label: string },
    required: boolean
  ) => (
    <label
      key={key}
      htmlFor={`metric-${key}`}
      className="block min-w-0 text-xs font-semibold"
    >
      {label}
      <input
        id={`metric-${key}`}
        name={key}
        type="number"
        min={0}
        max={Number.MAX_SAFE_INTEGER}
        step={1}
        inputMode="numeric"
        value={form[key]}
        onChange={e =>
          setField(key, e.target.value === "" ? 0 : Number(e.target.value))
        }
        aria-describedby="metric-count-help"
        className="mt-1 w-full min-w-0 h-10 px-3 rounded-xl border border-border bg-background text-foreground text-right font-bold focus-ring"
        required={required}
        disabled={loadingMonth || monthLoadFailed || saving}
      />
    </label>
  );

  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
              Manual Metric Entry
            </h1>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#5A92C9]/15 text-[#5A92C9] border border-[#5A92C9]/30">
              Module 3
            </span>
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
            Record seven monthly outreach fields independently. Existing months
            are updated only when you save.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
        <div className="min-w-0 lg:col-span-2 space-y-5">
          <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
            <h2 className="text-sm font-bold tracking-tight flex items-center gap-2">
              <Calendar size={16} className="text-[#5A92C9]" /> Reporting period
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block min-w-0 text-xs font-semibold">
                Reporting Month (Jan – Dec)
                <select
                  name="reporting_month"
                  value={form.reporting_month}
                  onChange={e =>
                    setField("reporting_month", Number(e.target.value))
                  }
                  disabled={saving}
                  className="mt-1 w-full min-w-0 h-10 px-3 rounded-xl border border-border bg-background text-foreground font-semibold focus-ring"
                >
                  {FULL_MONTHS.map((m, i) => (
                    <option key={m} value={i + 1}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block min-w-0 text-xs font-semibold">
                Reporting Year
                <input
                  name="reporting_year"
                  type="number"
                  min={2000}
                  max={2100}
                  step={1}
                  value={form.reporting_year}
                  onChange={e =>
                    setField("reporting_year", Number(e.target.value))
                  }
                  disabled={saving}
                  className="mt-1 w-full min-w-0 h-10 px-3 rounded-xl border border-border bg-background text-foreground font-semibold focus-ring"
                  required
                />
              </label>
            </div>
            {loadingMonth && (
              <p role="status" className="text-xs text-muted-foreground">
                Loading reporting month…
              </p>
            )}
          </section>

          <section
            aria-labelledby="monthly-fields-heading"
            className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4"
          >
            <div>
              <h2
                id="monthly-fields-heading"
                className="text-sm font-bold tracking-tight"
              >
                Monthly outreach fields
              </h2>
              <p
                id="metric-count-help"
                className="text-xs text-muted-foreground"
              >
                Use nonnegative whole numbers. Blank or unknown counts default
                to 0. Total calls, members reached, referrals, and completed
                rounds are recorded separately; totals are not calculated from
                the rounds or destinations.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {primaryFields.map(field => countInput(field, true))}
            </div>
          </section>

          <section
            aria-labelledby="additional-fields-heading"
            className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4"
          >
            <div>
              <h2
                id="additional-fields-heading"
                className="text-sm font-bold tracking-tight"
              >
                Additional legacy fields (optional)
              </h2>
              <p className="text-xs text-muted-foreground">
                ACA responses, household contacts, and JHPP / WR destination
                counts remain available. Saved values are retained when loading
                an existing month.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {additionalFields.map(field => countInput(field, false))}
            </div>
          </section>

          <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-2">
            <label className="block text-xs font-semibold">
              Notes / context (optional)
              <textarea
                name="notes"
                value={form.notes}
                onChange={e => setField("notes", e.target.value)}
                maxLength={2000}
                rows={2}
                disabled={loadingMonth || monthLoadFailed || saving}
                placeholder="Campaign context, staffing notes, data sources..."
                className="mt-1 w-full min-w-0 px-3 py-2 rounded-xl border border-border bg-background text-foreground text-xs focus-ring"
              />
            </label>
          </section>

          {message && (
            <div
              role={message.type === "err" ? "alert" : "status"}
              className={`p-3 rounded-xl text-xs flex items-start gap-2 break-words ${message.type === "ok" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30" : "bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30"}`}
            >
              {message.type === "ok" ? (
                <CheckCircle size={14} className="shrink-0" />
              ) : (
                <AlertCircle size={14} className="shrink-0" />
              )}
              <span className="min-w-0">{message.text}</span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={saving || loadingMonth || monthLoadFailed}
              className="touch-target inline-flex items-center gap-2 px-5 py-2 text-sm font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] disabled:opacity-50 focus-ring"
            >
              <Save size={15} />{" "}
              {saving
                ? "Saving…"
                : `Save ${FULL_MONTHS[form.reporting_month - 1]} ${form.reporting_year}`}
            </button>
            <button
              type="button"
              disabled={saving || loadingMonth || monthLoadFailed}
              onClick={() =>
                setForm(prev => ({
                  ...emptyForm,
                  reporting_year: prev.reporting_year,
                  reporting_month: prev.reporting_month,
                }))
              }
              className="touch-target px-4 py-2 text-xs font-semibold rounded-xl border border-border bg-card hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50 focus-ring"
            >
              Reset
            </button>
          </div>
        </div>

        <div className="min-w-0 space-y-4">
          <aside
            aria-label="Live monthly summary"
            className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4 lg:sticky lg:top-20"
          >
            <h2 className="text-sm font-bold tracking-tight flex items-center gap-2">
              <Sparkles size={16} className="text-[#D58240] shrink-0" /> Monthly
              summary (live)
            </h2>
            <dl className="space-y-3 text-xs">
              {[
                ["Total Number of Calls", preview.totalCalls.toLocaleString()],
                [
                  "Total number of members REACHED",
                  preview.membersReached.toLocaleString(),
                ],
                [
                  "Number of Referrals",
                  preview.totalReferrals.toLocaleString(),
                ],
                ["Round 1 / total calls", `${preview.round1Rate}%`],
                ["Round 2 / total calls", `${preview.round2Rate}%`],
                ["Round 3 / total calls", `${preview.round3Rate}%`],
                ["Calls per staff", String(preview.callsPerStaff)],
                ["Total ACA responses", preview.totalAca.toLocaleString()],
                ["ACA YES rate", `${preview.acaRate}%`],
                [
                  "JHPP / WR destination split",
                  `${preview.jhppShare}% / ${preview.wrShare}%`,
                ],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex justify-between gap-3 py-1 border-b border-border"
                >
                  <dt className="min-w-0 text-muted-foreground">{label}</dt>
                  <dd className="shrink-0 font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="text-[11px] text-muted-foreground">
              Totals use the independently entered fields. JHPP / WR percentages
              use only the sum of those destination counts, not Number of
              Referrals. Dashboard changes take effect after saving.
            </p>
          </aside>

          <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-3">
            <h2 className="text-sm font-bold tracking-tight flex items-center gap-2">
              <FileSpreadsheet size={16} className="text-[#5A92C9]" /> Bulk CSV
              import
            </h2>
            <p className="text-[11px] text-muted-foreground">
              Optional: paste CSV with reporting period and metric column
              headers. Nothing is imported until you choose Import rows.
              Existing months are updated.
            </p>
            <textarea
              aria-label="CSV to import"
              value={csvText}
              onChange={e => setCsvText(e.target.value)}
              rows={4}
              placeholder="reporting_year,reporting_month,staff_members,total_calls,members_reached,referrals,calls_round1,calls_round2,calls_round3,aca_yes,aca_no,head_of_household,calls_jhpp,calls_wr,notes"
              className="w-full min-w-0 px-3 py-2 rounded-xl border border-border bg-background text-foreground text-[11px] font-mono focus-ring"
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
              <div role="status" className="text-xs space-y-1">
                <div className="font-semibold text-emerald-500">
                  Imported: {importResult.imported} row(s)
                </div>
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
