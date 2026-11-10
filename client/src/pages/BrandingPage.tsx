import React, { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useBranding } from "../contexts/BrandingContext";
import { Palette, CheckCircle, AlertCircle, RefreshCw, Undo2, Sun, Moon, Monitor } from "lucide-react";

export function BrandingPage() {
  const { csrf } = useAuth();
  const { refresh: refreshGlobalBrand } = useBranding();
  const [b, setB] = useState<any>({
    company_name: "Welfare Pride",
    tagline: "HPP Reporting Portal",
    logo_url: "/assets/branding/welfare-pride-main-logo.webp",
    logo_dark_url: "",
    icon_url: "/assets/branding/welfare-pride-icon.png",
    favicon_url: "/assets/branding/welfare-pride-icon.png",
    primary_color: "#5A92C9",
    secondary_color: "#D58240",
    font_family: "Roboto",
    email_header_text: "Welfare Pride · Healthy Partners Program",
    default_theme: "system",
    allow_theme_override: 1,
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const load = async () => {
    const res = await fetch("/api/v1/branding");
    if (res.ok) setB(await res.json());
  };

  useEffect(() => { load(); }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/admin/branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
        body: JSON.stringify(b),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      setMessage({ type: "ok", text: "Branding updated. Changes apply immediately across all portal surfaces." });
      refreshGlobalBrand();
    } catch (err) {
      setMessage({ type: "err", text: String(err) });
    } finally {
      setSaving(false);
    }
  };

  const resetDefaults = async () => {
    const res = await fetch("/api/v1/admin/branding/reset", {
      method: "POST",
      headers: { ...(csrf ? { "x-csrf-token": csrf } : {}) },
    });
    if (res.ok) {
      load();
      refreshGlobalBrand();
      setMessage({ type: "ok", text: "Reset to Welfare Pride default brand guide." });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">White-Label Branding</h1>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#5A92C9]/15 text-[#5A92C9] border border-[#5A92C9]/30">Module 6</span>
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
            Customize company name, logos, brand colors, fonts, default theme, and email header text without code changes.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={resetDefaults} className="touch-target inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl border border-border bg-card hover:bg-muted focus-ring text-muted-foreground hover:text-foreground">
            <Undo2 size={13} /> Reset defaults
          </button>
        </div>
      </div>

      {message && (
        <div className={`p-3 rounded-xl text-xs flex items-center gap-2 ${message.type === "ok" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30" : "bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30"}`}>
          {message.type === "ok" ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          {message.text}
        </div>
      )}

      <form onSubmit={save} className="grid grid-cols-1 lg:grid-cols-3 gap-6 text-xs">
        <div className="lg:col-span-2 space-y-5">
          {/* Identity */}
          <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
            <h2 className="text-sm font-bold flex items-center gap-2"><Palette size={16} className="text-[#5A92C9]" /> Company identity</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="font-semibold">
                Company name
                <input type="text" value={b.company_name} onChange={e => setB((x: any) => ({ ...x, company_name: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background font-semibold focus-ring" />
              </label>
              <label className="font-semibold">
                Tagline
                <input type="text" value={b.tagline} onChange={e => setB((x: any) => ({ ...x, tagline: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background font-semibold focus-ring" />
              </label>
              <label className="font-semibold sm:col-span-2">
                Email header text
                <input type="text" value={b.email_header_text} onChange={e => setB((x: any) => ({ ...x, email_header_text: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring" />
              </label>
            </div>
          </section>

          {/* Logo assets */}
          <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
            <h2 className="text-sm font-bold">Logos & icons</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="font-semibold sm:col-span-2">
                Main logo URL (light surfaces)
                <input type="text" value={b.logo_url} onChange={e => setB((x: any) => ({ ...x, logo_url: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring font-mono text-[11px]" />
              </label>
              <label className="font-semibold sm:col-span-2">
                Dark-surface logo URL (optional white-text variant)
                <input type="text" value={b.logo_dark_url || ""} onChange={e => setB((x: any) => ({ ...x, logo_dark_url: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring font-mono text-[11px]" />
              </label>
              <label className="font-semibold">
                App icon URL
                <input type="text" value={b.icon_url} onChange={e => setB((x: any) => ({ ...x, icon_url: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring font-mono text-[11px]" />
              </label>
              <label className="font-semibold">
                Favicon URL
                <input type="text" value={b.favicon_url} onChange={e => setB((x: any) => ({ ...x, favicon_url: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring font-mono text-[11px]" />
              </label>
            </div>
          </section>

          {/* Colors */}
          <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
            <h2 className="text-sm font-bold">Brand colors (WCAG contrast compliant)</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="font-semibold">
                Primary color
                <div className="flex items-center gap-2 mt-1">
                  <input type="color" value={b.primary_color} onChange={e => setB((x: any) => ({ ...x, primary_color: e.target.value }))} className="h-10 w-14 rounded-lg border border-border cursor-pointer bg-background" />
                  <input type="text" value={b.primary_color} onChange={e => setB((x: any) => ({ ...x, primary_color: e.target.value }))} className="h-10 w-full px-3 rounded-xl border border-border bg-background font-mono font-semibold focus-ring uppercase" />
                </div>
              </label>
              <label className="font-semibold">
                Secondary color
                <div className="flex items-center gap-2 mt-1">
                  <input type="color" value={b.secondary_color} onChange={e => setB((x: any) => ({ ...x, secondary_color: e.target.value }))} className="h-10 w-14 rounded-lg border border-border cursor-pointer bg-background" />
                  <input type="text" value={b.secondary_color} onChange={e => setB((x: any) => ({ ...x, secondary_color: e.target.value }))} className="h-10 w-full px-3 rounded-xl border border-border bg-background font-mono font-semibold focus-ring uppercase" />
                </div>
              </label>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Welfare Pride reference: primary <code>#5A92C9</code> (RGB 90,146,201 · CMYK 75/30/2/0), secondary <code>#D58240</code> (RGB 213,130,64 · CMYK 3/59/88/0).
            </p>
          </section>

          {/* Theme defaults */}
          <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
            <h2 className="text-sm font-bold">Theme behaviour</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="font-semibold">
                Default theme (system mode is recommended)
                <select value={b.default_theme} onChange={e => setB((x: any) => ({ ...x, default_theme: e.target.value }))} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background font-semibold focus-ring">
                  <option value="system">System (follows OS preference) — default</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
              <label className="font-semibold flex items-center gap-2 mt-6 cursor-pointer">
                <input type="checkbox" checked={b.allow_theme_override === 1} onChange={e => setB((x: any) => ({ ...x, allow_theme_override: e.target.checked ? 1 : 0 }))} />
                <span>Allow users to toggle light/dark/system theme</span>
              </label>
            </div>
          </section>

          <div className="flex justify-end">
            <button type="submit" disabled={saving} className="touch-target px-5 py-2 font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] disabled:opacity-50 focus-ring">
              {saving ? "Saving…" : "Save branding"}
            </button>
          </div>
        </div>

        {/* Live preview */}
        <div className="space-y-4">
          <aside className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-3 lg:sticky lg:top-20">
            <h2 className="text-sm font-bold">Live preview</h2>
            <div className="rounded-xl border border-border p-3 space-y-2 bg-background">
              <div className="flex items-center gap-2">
                <img src={b.icon_url} alt="" className="h-8 w-8 rounded-full object-cover" />
                <div>
                  <div className="font-bold text-xs">{b.company_name}</div>
                  <div className="text-[10px] text-muted-foreground">{b.tagline}</div>
                </div>
              </div>
              <div className="flex gap-2">
                <span className="h-6 w-12 rounded" style={{ background: b.primary_color }} />
                <span className="h-6 w-12 rounded" style={{ background: b.secondary_color }} />
              </div>
              <div className="flex gap-2">
                <span className="text-[10px] px-2 py-0.5 rounded text-white font-bold" style={{ background: b.primary_color }}>Primary</span>
                <span className="text-[10px] px-2 py-0.5 rounded text-white font-bold" style={{ background: b.secondary_color }}>Secondary</span>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Branding configuration is stored in the database, included in full snapshot backups, and exportable as JSON.
            </p>
          </aside>
        </div>
      </form>
    </div>
  );
}
