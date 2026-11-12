import React, { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { Mail, CheckCircle, AlertCircle, RefreshCw, Send, RotateCcw } from "lucide-react";

export function EmailEnginePage() {
  const { csrf } = useAuth();
  const [cfg, setCfg] = useState<any>({
    provider: "smtp",
    smtp_host: "smtp.office365.com",
    smtp_port: 587,
    smtp_secure: false,
    smtp_user: "",
    smtp_pass: "",
    from_name: "Welfare Pride HPP Portal",
    from_address: "reports@welfarepride.org",
    global_bcc: "compliance@welfarepride.org",
    graph_tenant_id: "",
    graph_client_id: "",
    graph_client_secret: "",
    graph_mailbox: "",
  });
  const [cb, setCb] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const load = async () => {
    const [c, b, l] = await Promise.all([
      fetch("/api/v1/admin/email/config").then(r => r.json()),
      fetch("/api/v1/admin/email/circuit-breaker").then(r => r.json()),
      fetch("/api/v1/admin/email/logs").then(r => r.json()),
    ]);
    setCfg(c);
    setCb(b);
    setLogs(l.logs || []);
  };

  useEffect(() => { load(); }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/admin/email/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
        body: JSON.stringify(cfg),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Save failed");
      setMessage({ type: "ok", text: "Configuration saved. Warning: these credentials are currently stored unencrypted in the application database." });
      load();
    } catch (err) {
      setMessage({ type: "err", text: String(err) });
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setMessage(null);
    const res = await fetch("/api/v1/admin/email/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: JSON.stringify({ to: testTo || cfg.from_address }),
    });
    const d = await res.json();
    setMessage({ type: d.ok ? "ok" : "err", text: d.ok ? `Test email sent via ${d.provider}. Mandatory BCC applied.` : `Failed: ${d.error}` });
    load();
  };

  const resetCb = async () => {
    await fetch("/api/v1/admin/email/circuit-breaker/reset", {
      method: "POST",
      headers: { ...(csrf ? { "x-csrf-token": csrf } : {}) },
    });
    load();
  };

  const resend = async (id: string) => {
    const res = await fetch(`/api/v1/admin/email/logs/${id}/resend`, {
      method: "POST",
      headers: { ...(csrf ? { "x-csrf-token": csrf } : {}) },
    });
    const d = await res.json();
    setMessage({ type: d.ok ? "ok" : "err", text: d.ok ? "Mail re-queued and sent." : d.error });
    load();
  };

  const cbStateColor: Record<string, string> = {
    closed: "text-emerald-500",
    open: "text-rose-500",
    half_open: "text-amber-500",
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Resilient Email Engine</h1>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#5A92C9]/15 text-[#5A92C9] border border-[#5A92C9]/30">Module 4</span>
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
            Primary MS Graph API OAuth2 mail with SMTP failover, circuit breaker, mandatory global BCC, and full delivery logs.
          </p>
        </div>
        <button onClick={load} className="touch-target inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl border border-border bg-card hover:bg-muted focus-ring">
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {message && (
        <div className={`p-3 rounded-xl text-xs flex items-center gap-2 ${message.type === "ok" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30" : "bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30"}`}>
          {message.type === "ok" ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          {message.text}
        </div>
      )}

      {/* Circuit breaker banner */}
      <section className="rounded-2xl border border-border bg-card p-4 panel-shadow flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs">
        <div>
          <span className="font-bold">Circuit breaker:</span>{" "}
          <span className={`font-mono font-bold uppercase ${cbStateColor[cb?.state || "closed"]}`}>{cb?.state}</span>
          <span className="text-muted-foreground ml-3">failures: {cb?.failures}/3 · {cb?.openedAt ? `opened ${new Date(cb.openedAt).toLocaleTimeString()}` : "healthy"}</span>
        </div>
        <button onClick={resetCb} className="touch-target px-3 py-1.5 rounded-xl border border-border font-semibold hover:bg-muted focus-ring">
          Reset breaker
        </button>
      </section>

      <form onSubmit={save} className="space-y-6 text-xs">
        {/* Provider */}
        <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
          <h2 className="text-sm font-bold flex items-center gap-2"><Mail size={16} className="text-[#5A92C9]" /> Primary provider & sender identity</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <label className="font-semibold">
              Primary provider
              <select value={cfg.provider} onChange={e => setCfg((c: any) => ({ ...c, provider: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background font-semibold focus-ring">
                <option value="graph">Microsoft Graph API (OAuth2)</option>
                <option value="smtp">SMTP (Office 365, etc.)</option>
                <option value="simulation">Simulation (log only)</option>
              </select>
            </label>
            <label className="font-semibold">
              From name
              <input type="text" value={cfg.from_name} onChange={e => setCfg((c: any) => ({ ...c, from_name: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background font-semibold focus-ring" />
            </label>
            <label className="font-semibold">
              From address
              <input type="email" value={cfg.from_address} onChange={e => setCfg((c: any) => ({ ...c, from_address: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background font-semibold focus-ring" />
            </label>
            <label className="font-semibold sm:col-span-2 lg:col-span-3">
              Mandatory global BCC (comma-separated; every email copies these addresses)
              <input type="text" value={cfg.global_bcc} onChange={e => setCfg((c: any) => ({ ...c, global_bcc: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background font-semibold focus-ring" placeholder="compliance@welfarepride.org, audit@welfarepride.org" />
            </label>
          </div>
        </section>

        {/* MS Graph */}
        <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
          <h2 className="text-sm font-bold">Microsoft Graph API settings (primary)</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="font-semibold">
              Entra ID Tenant ID
              <input type="text" value={cfg.graph_tenant_id} onChange={e => setCfg((c: any) => ({ ...c, graph_tenant_id: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring font-mono" placeholder="00000000-0000-0000-0000-000000000000" />
            </label>
            <label className="font-semibold">
              App (client) ID
              <input type="text" value={cfg.graph_client_id} onChange={e => setCfg((c: any) => ({ ...c, graph_client_id: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring font-mono" />
            </label>
            <label className="font-semibold">
              Client secret (currently stored unencrypted)
              <input type="password" value={cfg.graph_client_secret} onChange={e => setCfg((c: any) => ({ ...c, graph_client_secret: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring" />
            </label>
            <label className="font-semibold">
              Send-as mailbox (UPN)
              <input type="email" value={cfg.graph_mailbox} onChange={e => setCfg((c: any) => ({ ...c, graph_mailbox: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring" placeholder="reports@welfarepride.org" />
            </label>
          </div>
        </section>

        {/* SMTP */}
        <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
          <h2 className="text-sm font-bold">SMTP settings (secondary / fallback)</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="font-semibold sm:col-span-2">
              Host
              <input type="text" value={cfg.smtp_host} onChange={e => setCfg((c: any) => ({ ...c, smtp_host: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring font-mono" />
            </label>
            <label className="font-semibold">
              Port
              <input type="number" value={cfg.smtp_port} onChange={e => setCfg((c: any) => ({ ...c, smtp_port: Number(e.target.value) }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring" />
            </label>
            <label className="font-semibold">
              User
              <input type="text" value={cfg.smtp_user} onChange={e => setCfg((c: any) => ({ ...c, smtp_user: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring" />
            </label>
            <label className="font-semibold sm:col-span-2">
              Password (currently stored unencrypted)
              <input type="password" value={cfg.smtp_pass} onChange={e => setCfg((c: any) => ({ ...c, smtp_pass: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring" />
            </label>
          </div>
          <label className="flex items-center gap-2 font-semibold cursor-pointer">
            <input type="checkbox" checked={cfg.smtp_secure} onChange={e => setCfg((c: any) => ({ ...c, smtp_secure: e.target.checked }))} />
            <span>Use TLS wrapper (port 465)</span>
          </label>
        </section>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <input type="email" value={testTo} onChange={e => setTestTo(e.target.value)} placeholder="test@recipient.org" className="h-10 px-3 rounded-xl border border-border bg-background focus-ring" />
            <button type="button" onClick={sendTest} className="touch-target px-4 py-2 font-bold rounded-xl border border-border hover:bg-muted focus-ring inline-flex items-center gap-1.5">
              <Send size={13} /> Send test email
            </button>
          </div>
          <button type="submit" disabled={saving} className="touch-target px-5 py-2 font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] disabled:opacity-50 focus-ring">
            {saving ? "Saving…" : "Save configuration"}
          </button>
        </div>
      </form>

      {/* Mail logs */}
      <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-3">
        <h2 className="text-sm font-bold tracking-tight">Mail delivery logs ({logs.length})</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left border-collapse">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="py-2 px-2">Time (UTC)</th>
                <th className="py-2 px-2">Recipient</th>
                <th className="py-2 px-2">Subject</th>
                <th className="py-2 px-2">Provider</th>
                <th className="py-2 px-2">Status</th>
                <th className="py-2 px-2">Error</th>
                <th className="py-2 px-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(l => (
                <tr key={l.id} className="border-b border-border/60">
                  <td className="py-2 px-2 font-mono text-[11px] whitespace-nowrap">{l.created_at}</td>
                  <td className="py-2 px-2 font-semibold">{l.to_address}</td>
                  <td className="py-2 px-2 truncate max-w-[260px]">{l.subject}</td>
                  <td className="py-2 px-2 font-mono uppercase text-[10px]">{l.provider_used}</td>
                  <td className="py-2 px-2">
                    <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full ${l.status === "sent" ? "bg-emerald-500/15 text-emerald-500" : "bg-rose-500/15 text-rose-500"}`}>
                      {l.status}
                    </span>
                  </td>
                  <td className="py-2 px-2 text-[10px] text-rose-500 truncate max-w-[200px]">{l.error_message || "—"}</td>
                  <td className="py-2 px-2 text-right">
                    <button onClick={() => resend(l.id)} className="px-2 py-1 rounded hover:bg-muted font-semibold text-[11px] text-[#5A92C9] inline-flex items-center gap-1">
                      <RotateCcw size={11} /> resend
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
