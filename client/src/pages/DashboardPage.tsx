import React, { useEffect, useState, useMemo } from "react";
import { Link } from "wouter";
import { MetricCard } from "../components/MetricCard";
import { useAuth } from "../contexts/AuthContext";
import {
  PhoneCall,
  CheckCircle2,
  Users2,
  UserCheck,
  Award,
  Share2,
  Calendar,
  Download,
  Plus,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
} from "recharts";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

interface MonthSeries {
  month: number;
  year: number;
  round1: number;
  round2: number;
  round3: number;
  totalCalls: number;
  acaYes: number;
  acaNo: number;
  acaRate: number;
  headOfHousehold: number;
  staff: number;
  callsPerStaff: number;
  jhpp: number;
  wr: number;
  referrals: number;
}

interface SummaryData {
  year: number;
  monthsWithData: number;
  totals: {
    totalCalls: number;
    calls_round1: number;
    calls_round2: number;
    calls_round3: number;
    round1Rate: number;
    round2Rate: number;
    round3Rate: number;
    totalAca: number;
    aca_yes: number;
    aca_no: number;
    acaRate: number;
    head_of_household: number;
    staff_members: number;
    callsPerStaff: number;
    totalReferrals: number;
    calls_jhpp: number;
    calls_wr: number;
    jhppShare: number;
    wrShare: number;
  };
  monthlySeries: MonthSeries[];
  latestDelta: { month: number; totalCallsPct: number; acaRateDelta: number; referralsPct: number } | null;
}

export function DashboardPage() {
  const { isViewOnly, canEdit } = useAuth();
  const [data, setData] = useState<SummaryData | null>(null);
  const [years, setYears] = useState<number[]>([]);
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getUTCFullYear());
  const [monthFilter, setMonthFilter] = useState<number | "all">("all");
  const [loading, setLoading] = useState(true);

  const fetchData = async (year: number) => {
    setLoading(true);
    try {
      const [sumRes, yrRes] = await Promise.all([
        fetch(`/api/v1/dashboard/summary?year=${year}`),
        fetch("/api/v1/metrics/years"),
      ]);
      if (sumRes.ok) setData(await sumRes.json());
      if (yrRes.ok) {
        const y = await yrRes.json();
        setYears(y.years || []);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(selectedYear); }, [selectedYear]);

  const series = data?.monthlySeries || [];
  const displayedSeries = useMemo(() => {
    if (monthFilter === "all") return series;
    return series.filter(s => s.month === monthFilter);
  }, [series, monthFilter]);

  const t = data?.totals;

  // Filtered view totals (when a single month is picked)
  const viewTotals = useMemo(() => {
    if (!data) return null;
    if (monthFilter === "all") return data.totals;
    const m = series.find(s => s.month === monthFilter);
    if (!m) return data.totals;
    const totalCalls = m.round1 + m.round2 + m.round3;
    const totalAca = m.acaYes + m.acaNo;
    const totalReferrals = m.jhpp + m.wr;
    return {
      totalCalls,
      calls_round1: m.round1,
      calls_round2: m.round2,
      calls_round3: m.round3,
      round1Rate: totalCalls ? Math.round((m.round1 / totalCalls) * 1000) / 10 : 0,
      round2Rate: totalCalls ? Math.round((m.round2 / totalCalls) * 1000) / 10 : 0,
      round3Rate: totalCalls ? Math.round((m.round3 / totalCalls) * 1000) / 10 : 0,
      totalAca,
      aca_yes: m.acaYes,
      aca_no: m.acaNo,
      acaRate: m.acaRate,
      head_of_household: m.headOfHousehold,
      staff_members: m.staff,
      callsPerStaff: m.callsPerStaff,
      totalReferrals,
      calls_jhpp: m.jhpp,
      calls_wr: m.wr,
      jhppShare: totalReferrals ? Math.round((m.jhpp / totalReferrals) * 1000) / 10 : 0,
      wrShare: totalReferrals ? Math.round((m.wr / totalReferrals) * 1000) / 10 : 0,
    };
  }, [data, monthFilter, series]);

  const donutData = useMemo(() => {
    if (!viewTotals) return [];
    return [
      { name: "ACA Yes", value: viewTotals.aca_yes, color: "#5A92C9" },
      { name: "ACA No", value: viewTotals.aca_no, color: "#8aa0b4" },
    ];
  }, [viewTotals]);

  const referralPieData = useMemo(() => {
    if (!viewTotals) return [];
    return [
      { name: "JHPP", value: viewTotals.calls_jhpp, color: "#D58240" },
      { name: "WR", value: viewTotals.calls_wr, color: "#5A92C9" },
    ];
  }, [viewTotals]);

  return (
    <div className="space-y-6">
      {/* Hero row */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">HPP Outreach Performance</h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
            Manual outreach metrics tracked by call round, ACA disposition, households, staffing, and referral destinations.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Year selector */}
          <div className="flex items-center gap-1.5 text-xs">
            <Calendar size={14} className="text-muted-foreground" />
            <select
              value={selectedYear}
              onChange={e => setSelectedYear(Number(e.target.value))}
              className="px-2.5 py-1.5 rounded-xl border border-border bg-card text-foreground font-semibold focus-ring"
            >
              {Array.from(new Set([selectedYear, ...years, new Date().getUTCFullYear()])).sort((a, b) => b - a).map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
          <button
            onClick={() => fetchData(selectedYear)}
            className="touch-target inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl border border-border bg-card hover:bg-muted focus-ring"
            aria-label="Refresh"
          >
            <RefreshCw size={13} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
          <a
            href={`/api/v1/metrics/export?year=${selectedYear}`}
            className="touch-target inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl border border-border bg-card hover:bg-muted focus-ring text-foreground"
          >
            <Download size={13} /> CSV
          </a>
          {canEdit && (
            <Link
              href="/metrics"
              className="touch-target inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] focus-ring"
            >
              <Plus size={13} /> Enter data
            </Link>
          )}
        </div>
      </div>

      {/* Month filter pills */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1 text-xs">
        <button
          onClick={() => setMonthFilter("all")}
          className={`px-3 py-1 rounded-full font-semibold whitespace-nowrap focus-ring ${monthFilter === "all" ? "bg-[#5A92C9] text-white" : "bg-card border border-border text-muted-foreground hover:text-foreground"}`}
        >
          All months
        </button>
        {MONTH_NAMES.map((m, i) => (
          <button
            key={m}
            onClick={() => setMonthFilter(i + 1)}
            className={`px-3 py-1 rounded-full font-semibold whitespace-nowrap focus-ring ${monthFilter === i + 1 ? "bg-[#5A92C9] text-white" : "bg-card border border-border text-muted-foreground hover:text-foreground"}`}
          >
            {m}
          </button>
        ))}
      </div>

      {/* KPI Cards — the 9 exact manual metrics + computed rates */}
      <section aria-label="Key performance indicators" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        <MetricCard
          title="Calls · 1st round"
          value={viewTotals?.calls_round1 ?? "—"}
          subtitle={`${viewTotals?.round1Rate ?? 0}% of all call volume`}
          delta={monthFilter === "all" && data?.latestDelta ? { value: data.latestDelta.totalCallsPct, label: "vs prior month" } : undefined}
          icon={<PhoneCall size={20} />}
          tone="blue"
        />
        <MetricCard
          title="Calls · 2nd round"
          value={viewTotals?.calls_round2 ?? "—"}
          subtitle={`${viewTotals?.round2Rate ?? 0}% of call volume`}
          icon={<PhoneCall size={20} />}
          tone="blue"
        />
        <MetricCard
          title="Calls · 3rd round"
          value={viewTotals?.calls_round3 ?? "—"}
          subtitle={`${viewTotals?.round3Rate ?? 0}% of call volume`}
          icon={<PhoneCall size={20} />}
          tone="blue"
        />
        <MetricCard
          title="ACA YES"
          value={viewTotals?.aca_yes ?? "—"}
          subtitle={`Acceptance rate: ${viewTotals?.acaRate ?? 0}% of responses`}
          delta={monthFilter === "all" && data?.latestDelta ? { value: data.latestDelta.acaRateDelta } : undefined}
          icon={<CheckCircle2 size={20} />}
          tone="green"
        />
        <MetricCard
          title="ACA No"
          value={viewTotals?.aca_no ?? "—"}
          subtitle={`Total ACA responses: ${(viewTotals?.totalAca ?? 0).toLocaleString()}`}
          icon={<CheckCircle2 size={20} />}
          tone="slate"
        />
        <MetricCard
          title="Head of Household"
          value={viewTotals?.head_of_household ?? "—"}
          subtitle="Household leads engaged"
          icon={<Users2 size={20} />}
          tone="amber"
        />
        <MetricCard
          title="Staff members"
          value={viewTotals?.staff_members ?? "—"}
          subtitle={`${viewTotals?.callsPerStaff ?? 0} calls per staff member`}
          icon={<UserCheck size={20} />}
          tone="purple"
        />
        <MetricCard
          title="Referrals · JHPP"
          value={viewTotals?.calls_jhpp ?? "—"}
          subtitle={`${viewTotals?.jhppShare ?? 0}% of ${(viewTotals?.totalReferrals ?? 0).toLocaleString()} referrals`}
          icon={<Share2 size={20} />}
          tone="amber"
        />
        <MetricCard
          title="Referrals · WR"
          value={viewTotals?.calls_wr ?? "—"}
          subtitle={`${viewTotals?.wrShare ?? 0}% of referral volume`}
          icon={<Share2 size={20} />}
          tone="blue"
        />
        <MetricCard
          title="Total call volume"
          value={viewTotals?.totalCalls ?? "—"}
          subtitle={`All three rounds combined (${displayedSeries.length} month${displayedSeries.length === 1 ? "" : "s"})`}
          icon={<Award size={20} />}
          tone="blue"
        />
      </section>

      {/* Charts row 1: calls by round stacked bars + ACA donut */}
      <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 rounded-2xl bg-card border border-border p-5 panel-shadow">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-bold tracking-tight">Calls completed by round · {selectedYear}</h2>
              <p className="text-xs text-muted-foreground">Stacked volume across round 1, round 2, and round 3 each month</p>
            </div>
          </div>
          <div className="h-64 sm:h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={displayedSeries.map(s => ({ ...s, name: MONTH_NAMES[s.month - 1] }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" />
                <XAxis dataKey="name" stroke="currentColor" className="text-xs text-muted-foreground" />
                <YAxis stroke="currentColor" className="text-xs text-muted-foreground" />
                <Tooltip contentStyle={{ background: "#132233", border: "1px solid #1d3347", borderRadius: 12, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="round1" name="Round 1" stackId="r" fill="#5A92C9" radius={[0, 0, 0, 0]} />
                <Bar dataKey="round2" name="Round 2" stackId="r" fill="#D58240" />
                <Bar dataKey="round3" name="Round 3" stackId="r" fill="#8aa0b4" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-2xl bg-card border border-border p-5 panel-shadow flex flex-col justify-between">
          <div>
            <h2 className="text-sm font-bold tracking-tight">ACA response mix</h2>
            <p className="text-xs text-muted-foreground">YES vs NO distribution for {monthFilter === "all" ? "the full year" : FULL_MONTHS[Number(monthFilter) - 1]}</p>
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={donutData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                  {donutData.map(d => <Cell key={d.name} fill={d.color} />)}
                </Pie>
                <Tooltip contentStyle={{ background: "#132233", border: "1px solid #1d3347", borderRadius: 12, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="text-xs text-center text-muted-foreground">
            {viewTotals?.totalAca ? `${viewTotals.aca_yes.toLocaleString()} YES (${viewTotals.acaRate}%) · ${viewTotals.aca_no.toLocaleString()} NO` : "No data"}
          </div>
        </div>
      </section>

      {/* Charts row 2: trend lines + referrals split */}
      <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 rounded-2xl bg-card border border-border p-5 panel-shadow">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-bold tracking-tight">Monthly trend · call volume & ACA acceptance rate</h2>
              <p className="text-xs text-muted-foreground">Tracking performance month over month throughout the year</p>
            </div>
            <span className="text-xs text-muted-foreground flex items-center gap-1"><TrendingUp size={13} /> {displayedSeries.length} points</span>
          </div>
          <div className="h-64 sm:h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={displayedSeries.map(s => ({ ...s, name: MONTH_NAMES[s.month - 1] }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" />
                <XAxis dataKey="name" stroke="currentColor" className="text-xs text-muted-foreground" />
                <YAxis yAxisId="left" stroke="currentColor" className="text-xs text-muted-foreground" />
                <YAxis yAxisId="right" orientation="right" stroke="currentColor" className="text-xs text-muted-foreground" unit="%" />
                <Tooltip contentStyle={{ background: "#132233", border: "1px solid #1d3347", borderRadius: 12, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line yAxisId="left" type="monotone" dataKey="totalCalls" name="Total calls" stroke="#5A92C9" strokeWidth={2.5} dot={{ r: 3 }} />
                <Line yAxisId="right" type="monotone" dataKey="acaRate" name="ACA YES %" stroke="#10b981" strokeWidth={2.5} dot={{ r: 3 }} />
                <Line yAxisId="left" type="monotone" dataKey="headOfHousehold" name="Head of household" stroke="#D58240" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-2xl bg-card border border-border p-5 panel-shadow flex flex-col justify-between">
          <div>
            <h2 className="text-sm font-bold tracking-tight">Referrals destination split</h2>
            <p className="text-xs text-muted-foreground">Calls referred to JHPP vs WR</p>
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={referralPieData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                  {referralPieData.map(d => <Cell key={d.name} fill={d.color} />)}
                </Pie>
                <Tooltip contentStyle={{ background: "#132233", border: "1px solid #1d3347", borderRadius: 12, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="text-xs text-center text-muted-foreground">
            {viewTotals?.totalReferrals ? `JHPP ${viewTotals.calls_jhpp.toLocaleString()} (${viewTotals.jhppShare}%) · WR ${viewTotals.calls_wr.toLocaleString()} (${viewTotals.wrShare}%)` : "No data"}
          </div>
        </div>
      </section>

      {/* Monthly history comparison table */}
      <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold tracking-tight">Monthly KPI history · {selectedYear}</h2>
            <p className="text-xs text-muted-foreground">All nine manual metrics plus computed rates per month, with full year totals</p>
          </div>
          <div className="flex items-center gap-2">
            <a href={`/api/v1/metrics/export?year=${selectedYear}`} className="text-xs font-semibold text-[#5A92C9] hover:underline flex items-center gap-1">
              <Download size={13} /> Export this table as CSV
            </a>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left border-collapse">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="py-2 px-2">Month</th>
                <th className="py-2 px-2 text-right">R1 calls</th>
                <th className="py-2 px-2 text-right">R2 calls</th>
                <th className="py-2 px-2 text-right">R3 calls</th>
                <th className="py-2 px-2 text-right">Total</th>
                <th className="py-2 px-2 text-right">ACA YES</th>
                <th className="py-2 px-2 text-right">ACA No</th>
                <th className="py-2 px-2 text-right">YES %</th>
                <th className="py-2 px-2 text-right">HOH</th>
                <th className="py-2 px-2 text-right">Staff</th>
                <th className="py-2 px-2 text-right">Calls/staff</th>
                <th className="py-2 px-2 text-right">JHPP</th>
                <th className="py-2 px-2 text-right">WR</th>
              </tr>
            </thead>
            <tbody>
              {series.map(s => (
                <tr key={s.month} className="border-b border-border/60 hover:bg-muted/40">
                  <td className="py-2 px-2 font-semibold">{FULL_MONTHS[s.month - 1]}</td>
                  <td className="py-2 px-2 text-right">{s.round1.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right">{s.round2.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right">{s.round3.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right font-semibold">{s.totalCalls.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right text-emerald-500 font-semibold">{s.acaYes.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right text-muted-foreground">{s.acaNo.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right font-semibold">{s.acaRate}%</td>
                  <td className="py-2 px-2 text-right">{s.headOfHousehold.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right">{s.staff}</td>
                  <td className="py-2 px-2 text-right">{s.callsPerStaff}</td>
                  <td className="py-2 px-2 text-right">{s.jhpp.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right">{s.wr.toLocaleString()}</td>
                </tr>
              ))}
              {t && (
                <tr className="border-t-2 border-border font-bold bg-muted/30">
                  <td className="py-2 px-2">FULL YEAR TOTAL</td>
                  <td className="py-2 px-2 text-right">{t.calls_round1.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right">{t.calls_round2.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right">{t.calls_round3.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right">{t.totalCalls.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right text-emerald-500">{t.aca_yes.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right text-muted-foreground">{t.aca_no.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right">{t.acaRate}%</td>
                  <td className="py-2 px-2 text-right">{t.head_of_household.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right">{t.staff_members}</td>
                  <td className="py-2 px-2 text-right">{t.callsPerStaff}</td>
                  <td className="py-2 px-2 text-right">{t.calls_jhpp.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right">{t.calls_wr.toLocaleString()}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
