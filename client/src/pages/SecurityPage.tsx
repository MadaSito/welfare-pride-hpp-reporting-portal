import React, { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { KeyRound, Shield, Lock, CheckCircle, AlertCircle, Trash2, Plus } from "lucide-react";

export function SecurityPage() {
  const { csrf } = useAuth();
  const [samlDraft, setSamlDraft] = useState({
    name: "",
    idpLoginUrl: "",
    idpIssuer: "",
    signingCertificate: "",
  });
  const [rules, setRules] = useState<any[]>([]);
  const [rulesLoaded, setRulesLoaded] = useState(false);
  const [newRule, setNewRule] = useState({ rule_type: "ip" as "ip" | "geo", action: "allow" as "allow" | "deny", value: "", label: "" });
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const load = async () => {
    try {
      const response = await fetch("/api/v1/admin/ip-rules");
      if (!response.ok) throw new Error();
      const data = await response.json();
      setRules(data.rules || []);
      setRulesLoaded(true);
    } catch {
      setRulesLoaded(false);
      setMessage({ type: "err", text: "Unable to load IP and geo rules." });
    }
  };

  useEffect(() => { load(); }, []);

  const addRule = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/v1/admin/ip-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: JSON.stringify(newRule),
    });
    const d = await res.json();
    if (res.ok) {
      setNewRule({ rule_type: "ip", action: "allow", value: "", label: "" });
      load();
    } else {
      setMessage({ type: "err", text: d.error });
    }
  };

  const delRule = async (id: string) => {
    const res = await fetch(`/api/v1/admin/ip-rules/${id}`, {
      method: "DELETE",
      headers: { ...(csrf ? { "x-csrf-token": csrf } : {}) },
    });
    if (res.ok) load();
  };

  return (
    <div className="space-y-6 text-xs">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">Security & SSO</h1>
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#5A92C9]/15 text-[#5A92C9] border border-[#5A92C9]/30">Module 1 + Edge</span>
        </div>
        <p className="text-muted-foreground mt-0.5">
          Security settings, IP allow/deny rules, geo-blocking, and rate limiting. Microsoft Entra ID SSO is in development and is not operational.
        </p>
      </div>

      {message && (
        <div className={`p-3 rounded-xl flex items-center gap-2 ${message.type === "ok" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30" : "bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30"}`}>
          {message.type === "ok" ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          {message.text}
        </div>
      )}

      {/* SSO */}
      <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold flex items-center gap-2"><KeyRound size={16} className="text-[#5A92C9]" /> Microsoft Entra ID SAML 2.0</h2>
          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-700 dark:text-amber-300">Not operational · Development</span>
        </div>
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 leading-relaxed text-amber-800 dark:text-amber-200">
          SAML and OIDC sign-in are not implemented. Do not convert users to SSO or configure Entra with these details yet; continue using local sign-in and MFA.
        </div>
        <div className="space-y-2">
          <h3 className="font-bold">Service provider details</h3>
          <p className="text-muted-foreground">These values will be available only after the SAML service provider is implemented and deployed.</p>
          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {["SP entity ID", "ACS URL", "Sign-on URL"].map(label => (
              <div key={label} className="rounded-xl border border-border bg-muted/30 p-3">
                <dt className="font-semibold">{label}</dt>
                <dd className="mt-1 text-muted-foreground">Not available — not implemented</dd>
              </div>
            ))}
          </dl>
        </div>
        <form onSubmit={e => e.preventDefault()} className="space-y-3" autoComplete="off">
          <div>
            <h3 className="font-bold">Identity provider details <span className="font-normal text-muted-foreground">(draft only)</span></h3>
            <p className="mt-1 text-muted-foreground">Entries stay in this page only and are lost on refresh or navigation. They are not saved or sent to the server.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="font-semibold">
              Configuration name
              <input type="text" value={samlDraft.name} onChange={e => setSamlDraft(s => ({ ...s, name: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring" placeholder="e.g. Microsoft Entra ID" />
            </label>
            <label className="font-semibold">
              IdP login URL
              <input type="url" value={samlDraft.idpLoginUrl} onChange={e => setSamlDraft(s => ({ ...s, idpLoginUrl: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background font-mono focus-ring" placeholder="Enter the Entra ID login URL" />
            </label>
            <label className="font-semibold sm:col-span-2">
              IdP issuer
              <input type="text" value={samlDraft.idpIssuer} onChange={e => setSamlDraft(s => ({ ...s, idpIssuer: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background font-mono focus-ring" placeholder="Enter the Entra ID identifier (issuer)" />
            </label>
            <label className="font-semibold sm:col-span-2">
              IdP X.509 signing certificate (Base64 PEM)
              <textarea value={samlDraft.signingCertificate} onChange={e => setSamlDraft(s => ({ ...s, signingCertificate: e.target.value }))} rows={5} spellCheck={false} className="mt-1 w-full px-3 py-2 rounded-xl border border-border bg-background font-mono text-[11px] focus-ring" placeholder="Paste the PEM certificate, including BEGIN CERTIFICATE and END CERTIFICATE lines" />
            </label>
          </div>
          <div className="flex justify-end">
            <button type="submit" disabled className="touch-target cursor-not-allowed px-5 py-2 font-bold rounded-xl bg-muted text-muted-foreground opacity-70">
              Save unavailable
            </button>
          </div>
        </form>
      </section>

      {/* IP rules */}
      <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
        <h2 className="text-sm font-bold flex items-center gap-2"><Shield size={16} className="text-[#5A92C9]" /> IP firewall & geo rules (server-side, Cloudflare-aware)</h2>
        <form onSubmit={addRule} className="grid grid-cols-1 sm:grid-cols-5 gap-2">
          <select value={newRule.rule_type} onChange={e => setNewRule((r: any) => ({ ...r, rule_type: e.target.value }))} className="h-9 px-2 rounded-xl border border-border bg-background font-semibold focus-ring">
            <option value="ip">IP / CIDR</option>
            <option value="geo">Geo country</option>
          </select>
          <select value={newRule.action} onChange={e => setNewRule((r: any) => ({ ...r, action: e.target.value }))} className="h-9 px-2 rounded-xl border border-border bg-background font-semibold focus-ring">
            <option value="allow">Allow</option>
            <option value="deny">Deny</option>
          </select>
          <input type="text" value={newRule.value} onChange={e => setNewRule((r: any) => ({ ...r, value: e.target.value }))} placeholder={newRule.rule_type === "ip" ? "203.0.113.0/24" : "US"} className="h-9 px-3 rounded-xl border border-border bg-background font-mono focus-ring sm:col-span-2" required />
          <input type="text" value={newRule.label} onChange={e => setNewRule((r: any) => ({ ...r, label: e.target.value }))} placeholder="label" className="h-9 px-3 rounded-xl border border-border bg-background focus-ring" />
          <button type="submit" className="sm:col-span-5 touch-target py-2 font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] focus-ring inline-flex items-center justify-center gap-1.5">
            <Plus size={13} /> Add rule
          </button>
        </form>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="py-2 px-2">Type</th>
                <th className="py-2 px-2">Action</th>
                <th className="py-2 px-2">Value</th>
                <th className="py-2 px-2">Label</th>
                <th className="py-2 px-2">Hits</th>
                <th className="py-2 px-2 text-right">Delete</th>
              </tr>
            </thead>
            <tbody>
              {!rulesLoaded ? (
                <tr><td colSpan={6} className="py-4 text-center text-muted-foreground">IP and geo rules are unavailable.</td></tr>
              ) : rules.length === 0 ? (
                <tr><td colSpan={6} className="py-4 text-center text-muted-foreground">No IP or geo rules defined. All traffic currently flows (subject to rate limits).</td></tr>
              ) : rules.map(r => (
                <tr key={r.id} className="border-b border-border/60">
                  <td className="py-2 px-2 font-semibold uppercase text-[10px]">{r.rule_type}</td>
                  <td className="py-2 px-2"><span className={`font-semibold uppercase text-[10px] ${r.action === "allow" ? "text-emerald-500" : "text-rose-500"}`}>{r.action}</span></td>
                  <td className="py-2 px-2 font-mono">{r.value}</td>
                  <td className="py-2 px-2 text-muted-foreground">{r.label}</td>
                  <td className="py-2 px-2 font-mono">{r.hit_count}</td>
                  <td className="py-2 px-2 text-right"><button onClick={() => delRule(r.id)} className="text-rose-500 hover:opacity-80 p-1"><Trash2 size={12} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Rate limiting overview */}
      <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-2 text-muted-foreground">
        <h2 className="text-sm font-bold text-foreground flex items-center gap-1.5"><Lock size={14} className="text-[#D58240]" /> Built-in rate limits</h2>
        <p>100 requests per minute per IP general cap; 5 failed login attempts per 15 minutes trigger a 15-minute account lock. IP resolution honors <code>CF-Connecting-IP</code> with RFC 1918 proxy trust validation.</p>
      </section>
    </div>
  );
}
