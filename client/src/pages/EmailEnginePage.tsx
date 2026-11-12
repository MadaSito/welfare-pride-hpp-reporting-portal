import React, { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { Mail, CheckCircle, AlertCircle, RefreshCw, Send, RotateCcw } from "lucide-react";

type Provider = "smtp" | "graph" | "simulation";
type EmailConfig = {
  primary_provider: Provider;
  secondary_provider: Provider | "";
  smtp_host: string;
  smtp_port: string;
  smtp_secure: boolean;
  smtp_user: string;
  smtp_from: string;
  graph_client_id: string;
  graph_tenant_id: string;
  graph_sender: string;
  global_bcc: string;
  enabled: boolean;
};
type Circuit = { consecutiveFailures: number; tripped: boolean; primaryDisabledUntil: string | null };
type MailLog = { id: string; created_at: string; recipient: string; subject: string; provider: string; status: string; error: string | null; payload: string | null };
type Message = { type: "ok" | "err"; text: string };

const inputClass = "mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring";
const configuredMarker = "__configured__";
const attachmentSubject = "[Attachment email: content not retained]";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const error = typeof data?.error === "string" ? data.error : `Request failed (HTTP ${res.status})`;
    throw new Error(error);
  }
  if (!data || typeof data !== "object") throw new Error("Invalid server response");
  return data as T;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "An unexpected error occurred";
}

type ConfigResponse = {
  primary_provider: Provider; secondary_provider: Provider | null;
  smtp_host: string | null; smtp_port: number | null; smtp_secure: number | null;
  smtp_user: string | null; smtp_pass: string | null; smtp_from: string | null;
  graph_client_id: string | null; graph_client_secret: string | null;
  graph_tenant_id: string | null; graph_sender: string | null; global_bcc: string | null;
  enabled: number; circuit?: Circuit;
};

function asForm(c: ConfigResponse): EmailConfig {
  return {
    primary_provider: c.primary_provider,
    secondary_provider: c.secondary_provider ?? "",
    smtp_host: c.smtp_host ?? "", smtp_port: c.smtp_port == null ? "" : String(c.smtp_port),
    smtp_secure: Boolean(c.smtp_secure), smtp_user: c.smtp_user ?? "", smtp_from: c.smtp_from ?? "",
    graph_client_id: c.graph_client_id ?? "", graph_tenant_id: c.graph_tenant_id ?? "",
    graph_sender: c.graph_sender ?? "", global_bcc: c.global_bcc ?? "", enabled: Boolean(c.enabled),
  };
}

export function EmailEnginePage() {
  const { csrf } = useAuth();
  const [cfg, setCfg] = useState<EmailConfig | null>(null);
  const [savedCfg, setSavedCfg] = useState<EmailConfig | null>(null);
  const [smtpPass, setSmtpPass] = useState("");
  const [graphSecret, setGraphSecret] = useState("");
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [graphConfigured, setGraphConfigured] = useState(false);
  const [clearSmtp, setClearSmtp] = useState(false);
  const [clearGraph, setClearGraph] = useState(false);
  const [circuit, setCircuit] = useState<Circuit | null>(null);
  const [logs, setLogs] = useState<MailLog[]>([]);
  const [activityError, setActivityError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [resending, setResending] = useState<string | null>(null);
  const [testTo, setTestTo] = useState("");
  const [message, setMessage] = useState<Message | null>(null);

  const acceptConfig = (c: ConfigResponse) => {
    const form = asForm(c);
    setCfg(form);
    setSavedCfg(form);
    // The server returns a marker, not the stored values. Never copy it into a password input or save payload.
    setSmtpConfigured(Boolean(c.smtp_pass));
    setGraphConfigured(Boolean(c.graph_client_secret));
    setSmtpPass(""); setGraphSecret(""); setClearSmtp(false); setClearGraph(false);
    if (c.circuit) setCircuit(c.circuit);
  };

  const load = async () => {
    setLoading(true);
    setMessage(null);
    const [configResult, logsResult] = await Promise.allSettled([
      request<ConfigResponse>("/api/v1/admin/email"),
      request<{ logs: MailLog[] }>("/api/v1/admin/mail-logs"),
    ]);
    if (configResult.status === "fulfilled") acceptConfig(configResult.value);
    else {
      setCfg(null);
      setSavedCfg(null);
      setMessage({ type: "err", text: `Could not load email configuration: ${errorText(configResult.reason)}` });
    }
    if (logsResult.status === "fulfilled" && Array.isArray(logsResult.value.logs)) {
      setLogs(logsResult.value.logs); setActivityError("");
    } else {
      setActivityError(`Could not load mail logs: ${logsResult.status === "rejected" ? errorText(logsResult.reason) : "Invalid server response"}`);
    }
    setLoading(false);
  };

  // Refresh activity without replacing unsaved form edits or entered replacement secrets.
  const refreshActivity = async () => {
    const [configResult, logsResult] = await Promise.allSettled([
      request<ConfigResponse>("/api/v1/admin/email"),
      request<{ logs: MailLog[] }>("/api/v1/admin/mail-logs"),
    ]);
    if (configResult.status === "fulfilled" && configResult.value.circuit) setCircuit(configResult.value.circuit);
    if (logsResult.status === "fulfilled" && Array.isArray(logsResult.value.logs)) setLogs(logsResult.value.logs);
    const errors: string[] = [];
    if (configResult.status === "rejected") errors.push(`circuit status: ${errorText(configResult.reason)}`);
    if (logsResult.status === "rejected") errors.push(`mail logs: ${errorText(logsResult.reason)}`);
    else if (!Array.isArray(logsResult.value.logs)) errors.push("mail logs: invalid server response");
    setActivityError(errors.length ? `Could not refresh ${errors.join("; ")}` : "");
  };

  useEffect(() => { void load(); }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cfg || !savedCfg) return;
    setMessage(null);
    const port = cfg.smtp_port === "" ? null : Number(cfg.smtp_port);
    if (cfg.smtp_port !== savedCfg.smtp_port && port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      setMessage({ type: "err", text: "SMTP port must be an integer between 1 and 65535, or left blank." }); return;
    }
    const bcc = cfg.global_bcc.trim();
    if (cfg.global_bcc !== savedCfg.global_bcc && bcc && bcc.split(",").some(address => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(address.trim()))) {
      setMessage({ type: "err", text: "Enter valid comma-separated email addresses for global BCC." }); return;
    }
    if (smtpPass === configuredMarker || graphSecret === configuredMarker) {
      setMessage({ type: "err", text: "The reserved configured marker cannot be used as a secret." }); return;
    }
    setSaving(true);
    try {
      // Send only changed, known writable columns. Unchanged nullable values and secrets stay untouched.
      const payload: Record<string, string | number | null> = {};
      if (cfg.primary_provider !== savedCfg.primary_provider) payload.primary_provider = cfg.primary_provider;
      if (cfg.secondary_provider !== savedCfg.secondary_provider) payload.secondary_provider = cfg.secondary_provider || null;
      if (cfg.smtp_host !== savedCfg.smtp_host) payload.smtp_host = cfg.smtp_host || null;
      if (cfg.smtp_port !== savedCfg.smtp_port) payload.smtp_port = port;
      if (cfg.smtp_secure !== savedCfg.smtp_secure) payload.smtp_secure = cfg.smtp_secure ? 1 : 0;
      if (cfg.smtp_user !== savedCfg.smtp_user) payload.smtp_user = cfg.smtp_user || null;
      if (cfg.smtp_from !== savedCfg.smtp_from) payload.smtp_from = cfg.smtp_from || null;
      if (cfg.graph_tenant_id !== savedCfg.graph_tenant_id) payload.graph_tenant_id = cfg.graph_tenant_id || null;
      if (cfg.graph_client_id !== savedCfg.graph_client_id) payload.graph_client_id = cfg.graph_client_id || null;
      if (cfg.graph_sender !== savedCfg.graph_sender) payload.graph_sender = cfg.graph_sender || null;
      if (cfg.global_bcc !== savedCfg.global_bcc) payload.global_bcc = cfg.global_bcc || null;
      if (cfg.enabled !== savedCfg.enabled) payload.enabled = cfg.enabled ? 1 : 0;
      if (clearSmtp) payload.smtp_pass = null;
      else if (smtpPass) payload.smtp_pass = smtpPass;
      if (clearGraph) payload.graph_client_secret = null;
      else if (graphSecret) payload.graph_client_secret = graphSecret;
      if (Object.keys(payload).length === 0) {
        setMessage({ type: "ok", text: "No changes to save." });
        return;
      }
      const result = await request<ConfigResponse>("/api/v1/admin/email", {
        method: "PUT", headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
        body: JSON.stringify(payload),
      });
      acceptConfig(result);
      setMessage({ type: "ok", text: "Configuration saved. Integration secrets are stored in plaintext; this portal is not production-ready." });
    } catch (err) {
      setMessage({ type: "err", text: `Could not save configuration: ${errorText(err)}` });
    } finally { setSaving(false); }
  };

  const sendTest = async () => {
    const to = testTo.trim();
    if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(to)) {
      setMessage({ type: "err", text: "Enter a valid test recipient email address." }); return;
    }
    setSending(true); setMessage(null);
    try {
      const result = await request<{ ok: boolean; provider: string; status: string; error?: string }>("/api/v1/admin/email/test", {
        method: "POST", headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
        body: JSON.stringify({ to }),
      });
      setMessage(result.ok
        ? { type: "ok", text: result.status === "simulated" ? "Test simulated; no email was sent." : `Test accepted by ${result.provider} for delivery.` }
        : { type: "err", text: `Test failed: ${result.error || "Unknown provider error"}` });
      await refreshActivity();
    } catch (err) { setMessage({ type: "err", text: `Test failed: ${errorText(err)}` }); }
    finally { setSending(false); }
  };

  const resend = async (id: string) => {
    setResending(id); setMessage(null);
    try {
      const result = await request<{ ok: boolean; provider: string; status: string; error?: string }>(`/api/v1/admin/mail-logs/${encodeURIComponent(id)}/resend`, {
        method: "POST", headers: { ...(csrf ? { "x-csrf-token": csrf } : {}) },
      });
      setMessage(result.ok
        ? { type: "ok", text: result.status === "simulated" ? "Resend simulated; no email was sent." : `Resend accepted by ${result.provider} for delivery.` }
        : { type: "err", text: `Resend failed: ${result.error || "Unknown provider error"}` });
      await refreshActivity();
    } catch (err) { setMessage({ type: "err", text: `Resend failed: ${errorText(err)}` }); }
    finally { setResending(null); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2"><h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Resilient Email Engine</h1><span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#5A92C9]/15 text-[#5A92C9] border border-[#5A92C9]/30">Module 4</span></div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">Configure SMTP or Microsoft Graph, provider fallback, global BCC and mail logs.</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading || saving} className="touch-target inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl border border-border bg-card hover:bg-muted disabled:opacity-50 focus-ring"><RefreshCw size={13} /> Refresh (discards unsaved edits)</button>
      </div>

      <div className="p-3 rounded-xl text-xs bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/30" role="status">
        Integration secrets are stored in plaintext in the application database. This portal is not production-ready. Do not use production credentials or sensitive data until the security gaps are addressed.
      </div>
      {message && <div role="alert" className={`p-3 rounded-xl text-xs flex items-center gap-2 ${message.type === "ok" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30" : "bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30"}`}>{message.type === "ok" ? <CheckCircle size={14} /> : <AlertCircle size={14} />}{message.text}</div>}

      <section className="rounded-2xl border border-border bg-card p-4 panel-shadow text-xs">
        <span className="font-bold">Circuit breaker:</span>{" "}
        {circuit ? <><span className={`font-mono font-bold uppercase ${circuit.tripped ? "text-rose-500" : "text-emerald-500"}`}>{circuit.tripped ? "tripped" : "available"}</span><span className="text-muted-foreground ml-3">consecutive primary failures: {circuit.consecutiveFailures}/3{circuit.tripped && circuit.primaryDisabledUntil ? ` · retry after ${new Date(circuit.primaryDisabledUntil).toLocaleString()}` : ""}</span></> : <span className="text-muted-foreground">unavailable</span>}
        <p className="text-muted-foreground mt-1">State is per server process; the primary becomes available after the cooldown. No manual reset is available.</p>
      </section>

      {loading && !cfg && <p className="text-xs text-muted-foreground">Loading email configuration…</p>}
      {cfg && <form onSubmit={save} className="space-y-6 text-xs">
        <fieldset disabled={saving || loading} className="space-y-6 disabled:opacity-60">
          <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
            <h2 className="text-sm font-bold flex items-center gap-2"><Mail size={16} className="text-[#5A92C9]" /> Providers &amp; sender</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="font-semibold">Primary provider<select value={cfg.primary_provider} onChange={e => setCfg({ ...cfg, primary_provider: e.target.value as Provider })} className={inputClass}><option value="smtp">SMTP</option><option value="graph">Microsoft Graph API (OAuth2)</option><option value="simulation">Simulation (no delivery)</option></select></label>
              <label className="font-semibold">Secondary provider<select value={cfg.secondary_provider} onChange={e => setCfg({ ...cfg, secondary_provider: e.target.value as Provider | "" })} className={inputClass}><option value="">Default fallback</option><option value="smtp">SMTP</option><option value="graph">Microsoft Graph API (OAuth2)</option><option value="simulation">Simulation (no delivery)</option></select></label>
              <label className="font-semibold sm:col-span-2">SMTP from address / display name<input type="text" value={cfg.smtp_from} onChange={e => setCfg({ ...cfg, smtp_from: e.target.value })} className={inputClass} placeholder={'"Portal" <reports@example.org>'} /><span className="block mt-1 font-normal text-muted-foreground">Used for SMTP only. Graph sends from the Graph mailbox below.</span></label>
              <label className="font-semibold sm:col-span-2">Global BCC (comma-separated)<input type="text" value={cfg.global_bcc} onChange={e => setCfg({ ...cfg, global_bcc: e.target.value })} className={inputClass} placeholder="compliance@example.org, audit@example.org" /></label>
            </div>
            <p className="text-muted-foreground">Default fallback is SMTP when Graph is primary; otherwise there is no fallback. A server environment setting can also force simulation or add BCC recipients. Simulation does not deliver mail.</p>
            <p className="text-amber-700 dark:text-amber-300">Report emails are blocked while any global BCC is configured, including via the server environment. BCC is applied to other mail, including test sends.</p>
            <label className="flex items-start gap-2 font-semibold"><input type="checkbox" checked={cfg.enabled} onChange={e => setCfg({ ...cfg, enabled: e.target.checked })} /><span>Stored enabled flag <span className="font-normal text-muted-foreground">(currently not enforced by the email sender; changing it does not enable or disable delivery)</span></span></label>
          </section>

          <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
            <h2 className="text-sm font-bold">Microsoft Graph API settings</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="font-semibold">Entra ID tenant ID<input type="text" value={cfg.graph_tenant_id} onChange={e => setCfg({ ...cfg, graph_tenant_id: e.target.value })} className={`${inputClass} font-mono`} /></label>
              <label className="font-semibold">App (client) ID<input type="text" value={cfg.graph_client_id} onChange={e => setCfg({ ...cfg, graph_client_id: e.target.value })} className={`${inputClass} font-mono`} /></label>
              <label className="font-semibold">Replacement client secret<input type="password" autoComplete="new-password" value={graphSecret} disabled={clearGraph} onChange={e => setGraphSecret(e.target.value)} className={inputClass} placeholder={graphConfigured ? "Configured — leave blank to keep" : "Not configured"} /><span className="block mt-1 font-normal text-muted-foreground">{graphConfigured ? "A secret is stored; it is not returned by the server." : "No secret is stored in the database."} Leave blank to keep unchanged.</span></label>
              <label className="font-semibold">Graph send-as mailbox (UPN)<input type="text" value={cfg.graph_sender} onChange={e => setCfg({ ...cfg, graph_sender: e.target.value })} className={inputClass} placeholder="reports@example.org" /></label>
            </div>
            <label className="flex items-center gap-2 font-semibold"><input type="checkbox" checked={clearGraph} onChange={e => { setClearGraph(e.target.checked); if (e.target.checked) setGraphSecret(""); }} /> Clear stored Graph client secret on save</label>
          </section>

          <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
            <h2 className="text-sm font-bold">SMTP settings</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="font-semibold sm:col-span-2">Host<input type="text" value={cfg.smtp_host} onChange={e => setCfg({ ...cfg, smtp_host: e.target.value })} className={`${inputClass} font-mono`} /></label>
              <label className="font-semibold">Port<input type="number" min="1" max="65535" step="1" value={cfg.smtp_port} onChange={e => setCfg({ ...cfg, smtp_port: e.target.value })} className={inputClass} /></label>
              <label className="font-semibold">User<input type="text" value={cfg.smtp_user} onChange={e => setCfg({ ...cfg, smtp_user: e.target.value })} className={inputClass} /></label>
              <label className="font-semibold sm:col-span-2">Replacement SMTP password<input type="password" autoComplete="new-password" value={smtpPass} disabled={clearSmtp} onChange={e => setSmtpPass(e.target.value)} className={inputClass} placeholder={smtpConfigured ? "Configured — leave blank to keep" : "Not configured"} /><span className="block mt-1 font-normal text-muted-foreground">{smtpConfigured ? "A password is stored; it is not returned by the server." : "No password is stored in the database."} Leave blank to keep unchanged.</span></label>
            </div>
            <label className="flex items-center gap-2 font-semibold"><input type="checkbox" checked={cfg.smtp_secure} onChange={e => setCfg({ ...cfg, smtp_secure: e.target.checked })} /> Use implicit TLS (usually port 465)</label>
            <label className="flex items-center gap-2 font-semibold"><input type="checkbox" checked={clearSmtp} onChange={e => { setClearSmtp(e.target.checked); if (e.target.checked) setSmtpPass(""); }} /> Clear stored SMTP password on save</label>
            <p className="text-muted-foreground">When database SMTP settings are blank, the server may use environment settings. Clearing a stored SMTP password does not clear an environment password.</p>
          </section>

          <div className="flex justify-end"><button type="submit" disabled={saving} className="touch-target px-5 py-2 font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] disabled:opacity-50 focus-ring">{saving ? "Saving…" : "Save configuration"}</button></div>
        </fieldset>
      </form>}

      <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-3 text-xs">
        <h2 className="text-sm font-bold">Send a test</h2>
        <p className="text-muted-foreground">Uses the saved configuration, not unsaved edits. This can send a real email and may copy global BCC recipients.</p>
        <div className="flex flex-col sm:flex-row gap-2"><label className="sr-only" htmlFor="email-test-recipient">Test recipient</label><input id="email-test-recipient" type="email" value={testTo} onChange={e => setTestTo(e.target.value)} placeholder="test@recipient.org" className="h-10 px-3 rounded-xl border border-border bg-background focus-ring" /><button type="button" onClick={() => void sendTest()} disabled={!cfg || loading || saving || sending} className="touch-target px-4 py-2 font-bold rounded-xl border border-border hover:bg-muted disabled:opacity-50 focus-ring inline-flex items-center gap-1.5"><Send size={13} /> {sending ? "Sending…" : "Send test email"}</button></div>
      </section>

      <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-3">
        <h2 className="text-sm font-bold tracking-tight">Mail delivery logs ({logs.length})</h2>
        {activityError && <p role="alert" className="text-xs text-rose-500">{activityError}</p>}
        <p className="text-xs text-muted-foreground">Resending uses the saved configuration and may send a real email. Attachment emails cannot be resent from logs because their content is not retained.</p>
        <div className="overflow-x-auto"><table className="w-full text-xs text-left border-collapse"><thead><tr className="border-b border-border text-muted-foreground"><th className="py-2 px-2">Time (UTC)</th><th className="py-2 px-2">Recipient</th><th className="py-2 px-2">Subject</th><th className="py-2 px-2">Provider</th><th className="py-2 px-2">Status</th><th className="py-2 px-2">Error</th><th className="py-2 px-2 text-right">Action</th></tr></thead><tbody>
          {logs.map(l => <tr key={l.id} className="border-b border-border/60"><td className="py-2 px-2 font-mono text-[11px] whitespace-nowrap">{l.created_at}</td><td className="py-2 px-2 font-semibold">{l.recipient}</td><td className="py-2 px-2 truncate max-w-[260px]">{l.subject}</td><td className="py-2 px-2 font-mono uppercase text-[10px]">{l.provider}</td><td className="py-2 px-2"><span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full ${l.status === "sent" ? "bg-emerald-500/15 text-emerald-500" : l.status === "simulated" ? "bg-amber-500/15 text-amber-600" : "bg-rose-500/15 text-rose-500"}`}>{l.status}</span></td><td className="py-2 px-2 text-[10px] text-rose-500 truncate max-w-[200px]">{l.error || "—"}</td><td className="py-2 px-2 text-right">{l.subject === attachmentSubject && !l.payload ? <span className="text-muted-foreground">Unavailable</span> : <button type="button" onClick={() => void resend(l.id)} disabled={resending !== null || loading || saving} className="px-2 py-1 rounded hover:bg-muted disabled:opacity-50 font-semibold text-[11px] text-[#5A92C9] inline-flex items-center gap-1"><RotateCcw size={11} /> {resending === l.id ? "Sending…" : "Resend"}</button>}</td></tr>)}
        </tbody></table></div>
      </section>
    </div>
  );
}
