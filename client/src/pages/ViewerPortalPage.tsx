import React, { useEffect, useState } from "react";
import { MetricCard } from "../components/MetricCard";
import {
  PhoneCall,
  CheckCircle2,
  Users2,
  Award,
  Share2,
  FileText,
  Calendar,
  Lock,
} from "lucide-react";

const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function ViewerPortalPage() {
  const [data, setData] = useState<any>(null);
  const [reports, setReports] = useState<any[]>([]);
  const [year] = useState(new Date().getUTCFullYear());

  useEffect(() => {
    fetch(`/api/v1/dashboard/summary?year=${year}`).then(r => r.ok && r.json()).then(setData);
    fetch("/api/v1/reports").then(r => r.ok && r.json()).then(d => setReports(d?.reports || []));
  }, [year]);

  const t = data?.totals;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Published Reports Portal</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Read-only view of dashboards and reports published to your account.
          </p>
        </div>
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <Lock size={12} className="text-emerald-500" /> View-only access
        </span>
      </div>

      <section aria-label="Key indicators" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard title="Total call volume" value={t?.totalCalls ?? "—"} subtitle="All three rounds" icon={<PhoneCall size={20} />} tone="blue" />
        <MetricCard title="ACA YES" value={t?.aca_yes ?? "—"} subtitle={`Acceptance rate ${t?.acaRate ?? 0}%`} icon={<CheckCircle2 size={20} />} tone="green" />
        <MetricCard title="Head of Household" value={t?.head_of_household ?? "—"} subtitle="Engaged households" icon={<Users2 size={20} />} tone="amber" />
        <MetricCard title="Total referrals" value={t?.totalReferrals ?? "—"} subtitle={`JHPP ${t?.jhppShare ?? 0}% · WR ${t?.wrShare ?? 0}%`} icon={<Share2 size={20} />} tone="blue" />
      </section>

      {/* Published reports list */}
      <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-3">
        <h2 className="text-sm font-bold tracking-tight flex items-center gap-2">
          <FileText size={16} className="text-[#5A92C9]" /> Published reports
        </h2>
        {reports.length === 0 ? (
          <p className="text-xs text-muted-foreground">No reports are currently published for your account.</p>
        ) : (
          <div className="divide-y divide-border">
            {reports.map(r => (
              <div key={r.id} className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div>
                  <div className="text-xs font-bold">{r.title}</div>
                  {r.description && <p className="text-[11px] text-muted-foreground line-clamp-1">{r.description}</p>}
                </div>
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground shrink-0">
                  <span className="flex items-center gap-1">
                    <Calendar size={12} /> {r.reporting_month ? `${FULL_MONTHS[r.reporting_month - 1]} ` : ""}{r.reporting_year}
                  </span>
                  <span>v{r.version}</span>
                  <a href={`/api/v1/reports/${r.id}/export`} className="font-semibold text-[#5A92C9] hover:underline">
                    Download
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Monthly summary table */}
      {data?.monthlySeries && (
        <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-3">
          <h2 className="text-sm font-bold tracking-tight">Monthly summary · {year}</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="py-2 px-2">Month</th>
                  <th className="py-2 px-2 text-right">Calls</th>
                  <th className="py-2 px-2 text-right">ACA YES</th>
                  <th className="py-2 px-2 text-right">ACA %</th>
                  <th className="py-2 px-2 text-right">HOH</th>
                  <th className="py-2 px-2 text-right">Staff</th>
                  <th className="py-2 px-2 text-right">Referrals</th>
                </tr>
              </thead>
              <tbody>
                {data.monthlySeries.map((s: any) => (
                  <tr key={s.month} className="border-b border-border/60">
                    <td className="py-2 px-2 font-semibold">{FULL_MONTHS[s.month - 1]}</td>
                    <td className="py-2 px-2 text-right">{s.totalCalls.toLocaleString()}</td>
                    <td className="py-2 px-2 text-right text-emerald-500 font-semibold">{s.acaYes.toLocaleString()}</td>
                    <td className="py-2 px-2 text-right">{s.acaRate}%</td>
                    <td className="py-2 px-2 text-right">{s.headOfHousehold.toLocaleString()}</td>
                    <td className="py-2 px-2 text-right">{s.staff}</td>
                    <td className="py-2 px-2 text-right">{s.referrals.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
