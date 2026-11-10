import React, { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { KeyRound, Shield, Globe, Lock, CheckCircle, AlertCircle, Trash2, Plus } from "lucide-react";

export function SecurityPage() {
  const { csrf } = useAuth();
  const [sso, setSso] = useState<any>({
    entra_enabled: false,
    entra_tenant_id: "",
    entra_client_id: "",
    entra_client_secret: "",
    entra_scopes: "openid profile email",
    idp_metadata_url: "",
  });
  const [rules, setRules] = useState<any[]>([]);
  const [newRule, setNewRule] = useState({ rule_type: "ip" as "ip" | "geo", action: "allow" as "allow" | "deny", value: "", label: "" });
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const load = async () => {
    const [s, r] = await Promise.all([
      fetch("/api/v1/admin/sso").then(x => x.json()),
      fetch("/api/v1/admin/ip-rules").then(x => x.json()),
    ]);
    setSso(s);
    setRules(r.rules || []);
  };

  useEffect(() => { load(); }, []);

  const saveSso = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    const res = await fetch("/api/v1/admin/sso", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: JSON.stringify(sso),
    });
    const d = await res.json();
    setMessage({ type: res.ok ? "ok" : "err", text: res.ok ? "Entra ID SSO configuration saved. Users converted to SSO sign in through Microsoft and bypass local MFA." : d.error });
  };

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
          Microsoft Entra ID SAML 2.0 / OIDC single sign-on with per-user conversion, IP allow/deny rules, geo-blocking, and rate limiting.
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
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold flex items-center gap-2"><KeyRound size={16} className="text-[#5A92C9]" /> Microsoft Entra ID (Azure AD) SSO</h2>
          <label className="flex items-center gap-2 font-semibold cursor-pointer">
            <input type="checkbox" checked={sso.entra_enabled} onChange={e => setSso((s: any) => ({ ...s, entra_enabled: e.target.checked }))} />
            <span>Enable Entra ID SSO</span>
          </label>
        </div>
        <form onSubmit={saveSso} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="font-semibold">
              Tenant ID
              <input type="text" value={sso.entra_tenant_id} onChange={e => setSso((s: any) => ({ ...s, entra_tenant_id: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background font-mono focus-ring" placeholder="00000000-0000-0000-0000-000000000000" />
            </label>
            <label className="font-semibold">
              Client ID
              <input type="text" value={sso.entra_client_id} onChange={e => setSso((s: any) => ({ ...s, entra_client_id: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background font-mono focus-ring" />
            </label>
            <label className="font-semibold">
              Client secret (stored encrypted)
              <input type="password" value={sso.entra_client_secret} onChange={e => setSso((s: any) => ({ ...s, entra_client_secret: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring" />
            </label>
            <label className="font-semibold">
              Scopes
              <input type="text" value={sso.entra_scopes} onChange={e => setSso((s: any) => ({ ...s, entra_scopes: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring" />
            </label>
            <label className="font-semibold sm:col-span-2">
              SAML 2.0 IdP metadata URL (optional)
              <input type="url" value={sso.idp_metadata_url} onChange={e => setSso((s: any) => ({ ...s, idp_metadata_url: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background font-mono text-[11px] focus-ring" placeholder="https://login.microsoftonline.com/{tenant}/federationmetadata/2007-06/federationmetadata.xml" />
            </label>
          </div>
          <div className="flex justify-end">
            <button type="submit" className="touch-target px-5 py-2 font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] focus-ring">
              Save SSO configuration
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
              {rules.length === 0 ? (
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
