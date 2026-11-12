import React, { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { Send, CheckCircle, AlertCircle, RefreshCw, Zap } from "lucide-react";

export function SiemPage() {
  const { csrf } = useAuth();
  const [cfg, setCfg] = useState({
    udp_enabled: false,
    udp_host: "10.0.0.53",
    udp_port: 514,
    facility: "local6",
    webhook_enabled: false,
    webhook_url: "https://siem.intranet.org/receiver",
    bearer_token: "",
    payload_format: "json",
  });
  const [queue, setQueue] = useState<{ queueLength: number; maxRetries: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const fetchCfg = async () => {
    const [c, q] = await Promise.all([
      fetch("/api/v1/admin/siem").then(r => r.json()),
      fetch("/api/v1/admin/siem/queue").then(r => r.json()),
    ]);
    setCfg(c);
    setQueue(q);
  };

  useEffect(() => { fetchCfg(); }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/admin/siem", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
        body: JSON.stringify(cfg),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Save failed");
      setMessage({ type: "ok", text: "SIEM configuration saved. Audit events stream live from this point." });
    } catch (err) {
      setMessage({ type: "err", text: String(err) });
    } finally {
      setSaving(false);
    }
  };

  const testUdp = async () => {
    const res = await fetch("/api/v1/admin/siem/test-udp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: JSON.stringify(cfg),
    });
    const d = await res.json();
    setMessage({ type: res.ok ? "ok" : "err", text: res.ok ? "Test RFC 5424 syslog frame dispatched." : d.error });
  };

  const testWebhook = async () => {
    const res = await fetch("/api/v1/admin/siem/test-webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: JSON.stringify(cfg),
    });
    const d = await res.json();
    setMessage({ type: d.ok ? "ok" : "err", text: d.ok ? "Test webhook delivered (HTTP 2xx)." : d.error || "Delivery failed" });
  };

  const flush = async () => {
    const res = await fetch("/api/v1/admin/siem/queue/flush", {
      method: "POST",
      headers: { ...(csrf ? { "x-csrf-token": csrf } : {}) },
    });
    const d = await res.json();
    setMessage({ type: "ok", text: `Buffer flushed (${d.flushed} events).` });
    fetchCfg();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">SIEM & Syslog Forwarding</h1>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#5A92C9]/15 text-[#5A92C9] border border-[#5A92C9]/30">Module 2</span>
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
            Dual-stream audit dispatch: RFC 5424 syslog over UDP plus an HTTP REST webhook with retry buffers and RFC 1918 destination allowlisting.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchCfg} className="touch-target inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl border border-border bg-card hover:bg-muted focus-ring">
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>

      {message && (
        <div className={`p-3 rounded-xl text-xs flex items-center gap-2 ${message.type === "ok" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30" : "bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30"}`}>
          {message.type === "ok" ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          {message.text}
        </div>
      )}

      {/* Queue status */}
      <section className="rounded-2xl border border-border bg-card p-4 panel-shadow flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs">
        <div>
          <span className="font-bold">Buffered event queue:</span> {queue?.queueLength ?? 0} events waiting (max {queue?.maxRetries ?? 5} retries)
        </div>
        <button onClick={flush} className="touch-target px-3 py-1.5 rounded-xl border border-border font-semibold hover:bg-muted focus-ring">
          Flush buffer now
        </button>
      </section>

      <form onSubmit={save} className="space-y-6">
        {/* UDP */}
        <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold flex items-center gap-2">
              <Send size={16} className="text-[#5A92C9]" /> RFC 5424 Syslog over UDP
            </h2>
            <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer">
              <input type="checkbox" checked={cfg.udp_enabled} onChange={e => setCfg(c => ({ ...c, udp_enabled: e.target.checked }))} />
              <span>Enable UDP stream</span>
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Destination must resolve to RFC 1918 / RFC 6598 / CGNAT private ranges (loopback is rejected). Structured data embeds correlation request IDs and ISO 8601 UTC timestamps.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <label className="font-semibold sm:col-span-2">
              Host / IP
              <input type="text" value={cfg.udp_host} onChange={e => setCfg(c => ({ ...c, udp_host: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background font-semibold focus-ring" placeholder="10.0.0.53" />
            </label>
            <label className="font-semibold">
              Port
              <input type="number" min={1} max={65535} value={cfg.udp_port} onChange={e => setCfg(c => ({ ...c, udp_port: Number(e.target.value) }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background font-semibold focus-ring" />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={testUdp} className="touch-target px-3 py-1.5 text-xs font-semibold rounded-xl border border-border hover:bg-muted focus-ring">
              Test UDP send
            </button>
          </div>
        </section>

        {/* Webhook */}
        <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold flex items-center gap-2">
              <Zap size={16} className="text-[#D58240]" /> HTTP REST Webhook
            </h2>
            <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer">
              <input type="checkbox" checked={cfg.webhook_enabled} onChange={e => setCfg(c => ({ ...c, webhook_enabled: e.target.checked }))} />
              <span>Enable webhook stream</span>
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <label className="font-semibold sm:col-span-2">
              Endpoint URL (HTTPS strongly recommended)
              <input type="url" value={cfg.webhook_url} onChange={e => setCfg(c => ({ ...c, webhook_url: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background font-semibold focus-ring" placeholder="https://siem.intranet.org/receiver" />
            </label>
            <label className="font-semibold">
              Bearer token (currently stored unencrypted; optional)
              <input type="password" value={cfg.bearer_token} onChange={e => setCfg(c => ({ ...c, bearer_token: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring" placeholder="eyJhbGciOi..." />
            </label>
            <label className="font-semibold">
              Payload format
              <select value={cfg.payload_format} onChange={e => setCfg(c => ({ ...c, payload_format: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background font-semibold focus-ring">
                <option value="json">JSON-lines</option>
                <option value="cef">Common Event Format (CEF)</option>
                <option value="leef">Log Extended Event Format (LEEF)</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={testWebhook} className="touch-target px-3 py-1.5 text-xs font-semibold rounded-xl border border-border hover:bg-muted focus-ring">
              Test webhook
            </button>
          </div>
        </section>

        <div className="flex items-center justify-end gap-3">
          <button type="submit" disabled={saving} className="touch-target px-5 py-2 text-xs font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] disabled:opacity-50 focus-ring">
            {saving ? "Saving…" : "Save configuration"}
          </button>
        </div>
      </form>
    </div>
  );
}
