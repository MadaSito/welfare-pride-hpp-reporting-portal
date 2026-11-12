import React, { useEffect, useState } from "react";
import {
  Shield,
  Search,
  Filter,
  Download,
  Calendar,
  ChevronDown,
  ChevronRight,
  Globe,
  RefreshCw,
} from "lucide-react";

interface AuditEvent {
  id: string;
  request_id: string;
  actor_id: string | null;
  actor_role: string | null;
  actor_email: string | null;
  action: string;
  severity: "info" | "warning" | "critical";
  resource_type: string;
  resource_id: string | null;
  real_ip: string | null;
  geo_country: string | null;
  user_agent: string | null;
  method: string;
  status_code: number;
  before_state: string | null;
  after_state: string | null;
  metadata: string | null;
  occurred_at: string;
}

export function AuditCenterPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [search, setSearch] = useState("");
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [severity, setSeverity] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [correlationId, setCorrelationId] = useState("");
  const [page, setPage] = useState(0);
  const limit = 50;

  const fetchEvents = async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (search) p.set("search", search);
      if (actor) p.set("actor", actor);
      if (action) p.set("action", action);
      if (severity !== "all") p.set("severity", severity);
      if (from) p.set("from", from);
      if (to) p.set("to", to);
      if (correlationId) p.set("correlationId", correlationId);
      p.set("limit", String(limit));
      p.set("offset", String(page * limit));
      const res = await fetch(`/api/v1/admin/audit?${p}`);
      if (res.ok) {
        const d = await res.json();
        setEvents(d.events || []);
        setTotal(d.total || 0);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchEvents(); }, [severity, page]);

  const sevColor: Record<string, string> = {
    info: "bg-blue-500/15 text-blue-600 dark:text-blue-300 border-blue-500/30",
    warning: "bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30",
    critical: "bg-rose-500/15 text-rose-600 dark:text-rose-300 border-rose-500/30",
  };

  const pages = Math.ceil(total / limit);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Audit Center</h1>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#5A92C9]/15 text-[#5A92C9] border border-[#5A92C9]/30">Module 2</span>
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
            Correlation-ID-tracked event log with IP, geo-country, and available before/after details. Database-level tamper protection is not yet implemented.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchEvents} className="touch-target inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl border border-border bg-card hover:bg-muted focus-ring">
            <RefreshCw size={13} /> Refresh
          </button>
          <a
            href="/api/v1/admin/audit/export"
            className="touch-target inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] focus-ring"
          >
            <Download size={13} /> Export CSV
          </a>
        </div>
      </div>

      {/* Filter panel */}
      <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-3 text-xs">
        <h2 className="text-sm font-bold flex items-center gap-1.5"><Filter size={14} /> Advanced filters</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-2.5 text-muted-foreground" />
            <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Full-text search…" className="w-full h-8 pl-8 pr-3 rounded-full border border-border bg-background text-xs focus-ring" />
          </div>
          <input type="text" value={actor} onChange={e => setActor(e.target.value)} placeholder="Actor email or id" className="h-8 px-3 rounded-full border border-border bg-background text-xs focus-ring" />
          <input type="text" value={action} onChange={e => setAction(e.target.value)} placeholder="Action code (e.g. auth.*)" className="h-8 px-3 rounded-full border border-border bg-background text-xs focus-ring" />
          <select value={severity} onChange={e => { setSeverity(e.target.value); setPage(0); }} className="h-8 px-3 rounded-full border border-border bg-background text-xs font-semibold focus-ring">
            <option value="all">All severities</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="h-8 px-3 rounded-full border border-border bg-background text-xs focus-ring" title="From date" />
          <input type="date" value={to} onChange={e => setTo(e.target.value)} className="h-8 px-3 rounded-full border border-border bg-background text-xs focus-ring" title="To date" />
          <input type="text" value={correlationId} onChange={e => setCorrelationId(e.target.value)} placeholder="Correlation request ID" className="h-8 px-3 rounded-full border border-border bg-background text-xs font-mono focus-ring sm:col-span-2" />
        </div>
        <div className="flex justify-end">
          <button onClick={() => { setPage(0); fetchEvents(); }} className="touch-target px-4 py-1.5 rounded-full bg-[#5A92C9] text-white font-bold hover:bg-[#4a80b3] focus-ring">
            Apply filters
          </button>
        </div>
      </section>

      {/* Events table */}
      <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-3">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{total} events</span>
          <span>page {page + 1} of {Math.max(1, pages)}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left border-collapse">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="py-2 px-2 w-6"></th>
                <th className="py-2 px-2">Occurred (UTC)</th>
                <th className="py-2 px-2">Action</th>
                <th className="py-2 px-2">Actor</th>
                <th className="py-2 px-2">Severity</th>
                <th className="py-2 px-2">Resource</th>
                <th className="py-2 px-2">Real IP · Geo</th>
                <th className="py-2 px-2">Correlation</th>
              </tr>
            </thead>
            <tbody>
              {events.map(ev => {
                const isOpen = !!expanded[ev.id];
                return (
                  <React.Fragment key={ev.id}>
                    <tr onClick={() => setExpanded(e => ({ ...e, [ev.id]: !isOpen }))} className="border-b border-border/60 hover:bg-muted/40 cursor-pointer">
                      <td className="py-2 px-2">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                      <td className="py-2 px-2 font-mono text-[11px] whitespace-nowrap">{ev.occurred_at}</td>
                      <td className="py-2 px-2 font-bold font-mono">{ev.action}</td>
                      <td className="py-2 px-2">
                        <div className="font-semibold">{ev.actor_email || "anonymous"}</div>
                        <div className="text-[10px] text-muted-foreground">{ev.actor_role || ""}</div>
                      </td>
                      <td className="py-2 px-2">
                        <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full border ${sevColor[ev.severity]}`}>
                          {ev.severity}
                        </span>
                      </td>
                      <td className="py-2 px-2 font-mono text-[11px]">{ev.resource_type}{ev.resource_id ? ` · ${ev.resource_id.slice(0, 16)}` : ""}</td>
                      <td className="py-2 px-2 text-[11px]">
                        <span className="font-mono">{ev.real_ip || "—"}</span> {ev.geo_country && <span className="uppercase text-[10px] text-muted-foreground">({ev.geo_country})</span>}
                      </td>
                      <td className="py-2 px-2 font-mono text-[10px] text-muted-foreground">{ev.request_id.slice(0, 8)}…</td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-muted/30">
                        <td colSpan={8} className="p-3 font-mono text-[11px] space-y-1">
                          <div><span className="text-muted-foreground">method/status:</span> {ev.method} {ev.status_code} · <span className="text-muted-foreground">UA:</span> {ev.user_agent || "—"}</div>
                          <div><span className="text-muted-foreground">request_id:</span> {ev.request_id}</div>
                          {ev.before_state && <div><span className="text-muted-foreground">before:</span> {ev.before_state}</div>}
                          {ev.after_state && <div><span className="text-muted-foreground">after:</span> {ev.after_state}</div>}
                          <div><span className="text-muted-foreground">metadata:</span> {ev.metadata}</div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div className="flex justify-end gap-1 text-xs pt-2">
            <button disabled={page === 0} onClick={() => setPage(p => p - 1)} className="px-3 py-1 rounded-lg border border-border disabled:opacity-40">Previous</button>
            <button disabled={page >= pages - 1} onClick={() => setPage(p => p + 1)} className="px-3 py-1 rounded-lg border border-border disabled:opacity-40">Next</button>
          </div>
        )}
      </section>
    </div>
  );
}
