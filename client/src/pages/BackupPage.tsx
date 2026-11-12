import React, { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { HardDrive, Download, Upload, Trash2, CheckCircle, AlertCircle, RefreshCw, Lock, Shield } from "lucide-react";

export function BackupPage() {
  const { csrf, isSuperAdmin } = useAuth();
  const [backups, setBackups] = useState<any[]>([]);
  const [encPassword, setEncPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // Restore form
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePass, setRestorePass] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [restoreResult, setRestoreResult] = useState<any>(null);
  const [restoring, setRestoring] = useState(false);

  // Config import
  const [configText, setConfigText] = useState("");
  const [configResult, setConfigResult] = useState<any>(null);

  const load = async () => {
    const res = await fetch("/api/v1/admin/backups");
    if (res.ok) {
      const d = await res.json();
      setBackups(d.backups || []);
    }
  };

  useEffect(() => { load(); }, []);

  const create = async () => {
    setCreating(true);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/admin/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
        body: JSON.stringify({ encryptionPassword: encPassword || undefined }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      setMessage({ type: "ok", text: `Snapshot created: ${d.filename} (${(d.bytes / 1024).toFixed(0)} KB)` });
      setEncPassword("");
      load();
    } catch (e) {
      setMessage({ type: "err", text: String(e) });
    } finally {
      setCreating(false);
    }
  };

  const remove = async (id: string, filename: string) => {
    if (!confirm(`Delete backup ${filename}?`)) return;
    const res = await fetch(`/api/v1/admin/backups/${id}?filename=${encodeURIComponent(filename)}`, {
      method: "DELETE",
      headers: { ...(csrf ? { "x-csrf-token": csrf } : {}) },
    });
    if (res.ok) load();
  };

  const doRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!restoreFile) return;
    setRestoring(true);
    setRestoreResult(null);
    try {
      const fd = new FormData();
      fd.append("backup", restoreFile);
      if (restorePass) fd.append("password", restorePass);
      fd.append("dryRun", String(dryRun));
      const res = await fetch("/api/v1/admin/restore", {
        method: "POST",
        headers: { ...(csrf ? { "x-csrf-token": csrf } : {}) },
        body: fd,
      });
      const d = await res.json();
      setRestoreResult(d);
      if (res.ok && !dryRun) {
        setMessage({ type: "ok", text: "Restore completed. Pre-restore safety snapshot taken." });
        load();
      }
    } catch (e) {
      setRestoreResult({ ok: false, error: String(e) });
    } finally {
      setRestoring(false);
    }
  };

  const exportConfig = async () => {
    const res = await fetch("/api/v1/admin/config/export");
    const d = await res.json();
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `welfare-pride-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };

  const importConfig = async () => {
    try {
      const res = await fetch("/api/v1/admin/config/import", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
        body: JSON.stringify({ config: configText }),
      });
      const d = await res.json();
      if (res.ok) setConfigResult({ ok: true });
      else setConfigResult({ ok: false, error: d.error });
    } catch (e) {
      setConfigResult({ ok: false, error: String(e) });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Backup & Portability</h1>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#5A92C9]/15 text-[#5A92C9] border border-[#5A92C9]/30">Module 5</span>
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
            Backup creation and restore are temporarily unavailable pending security and integrity fixes. Existing backup files may be unencrypted.
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

      {/* Create snapshot */}
      <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4 text-xs">
        <h2 className="text-sm font-bold flex items-center gap-2"><HardDrive size={16} className="text-[#5A92C9]" /> Create full snapshot</h2>
        <p className="text-muted-foreground">
          Snapshot creation is disabled because previous versions could create unencrypted archives even when a password was entered.
        </p>
        <div className="flex flex-col sm:flex-row gap-3">
          <label className="flex-1 font-semibold">
            Encryption password (leave blank for standard zip)
            <div className="relative mt-1">
              <Lock size={14} className="absolute left-3 top-2.5 text-muted-foreground" />
              <input type="password" value={encPassword} onChange={e => setEncPassword(e.target.value)} className="w-full h-10 pl-8 pr-3 rounded-xl border border-border bg-background focus-ring font-mono text-xs" />
            </div>
          </label>
          <div className="flex items-end">
            <button type="button" onClick={create} disabled className="touch-target px-5 py-2 font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] disabled:opacity-50 focus-ring">
              {creating ? "Creating…" : "Snapshot creation unavailable"}
            </button>
          </div>
        </div>
      </section>

      {/* Existing snapshots */}
      <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-3">
        <h2 className="text-sm font-bold tracking-tight">Existing snapshots ({backups.length})</h2>
        <div className="overflow-x-auto text-xs">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="py-2 px-2">Filename</th>
                <th className="py-2 px-2">Type</th>
                <th className="py-2 px-2">Size</th>
                <th className="py-2 px-2">SHA-256</th>
                <th className="py-2 px-2">Created (UTC)</th>
                <th className="py-2 px-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {backups.map(b => (
                <tr key={b.id} className="border-b border-border/60">
                  <td className="py-2 px-2 font-mono font-semibold">{b.filename}</td>
                  <td className="py-2 px-2">
                    <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full ${b.kind === "encrypted" ? "bg-purple-500/15 text-purple-400" : "bg-slate-500/15 text-slate-400"}`}>
                      {b.kind}
                    </span>
                  </td>
                  <td className="py-2 px-2">{(b.bytes / 1024).toFixed(0)} KB</td>
                  <td className="py-2 px-2 font-mono text-[10px] text-muted-foreground">{b.sha256 ? `${b.sha256.slice(0, 16)}…` : "—"}</td>
                  <td className="py-2 px-2 font-mono text-[11px] text-muted-foreground">{b.created_at}</td>
                  <td className="py-2 px-2 text-right">
                    <a href={`/api/v1/admin/backups/download/${b.filename}`} className="px-2 py-1 rounded font-semibold text-[11px] text-[#5A92C9] hover:underline inline-flex items-center gap-1 mr-2">
                      <Download size={11} /> download
                    </a>
                    {isSuperAdmin && (
                      <button onClick={() => remove(b.id, b.filename)} className="p-1 rounded text-rose-500 hover:bg-rose-500/10" title="Delete">
                        <Trash2 size={12} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Restore */}
      <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4 text-xs">
        <h2 className="text-sm font-bold flex items-center gap-2"><Upload size={16} className="text-[#D58240]" /> Restore from snapshot</h2>
        <p className="text-muted-foreground">
          Restore is disabled: the previous implementation could overwrite an open database without reliable validation. Preserve existing files and seek a tested offline recovery procedure.
        </p>
        <form onSubmit={doRestore} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="font-semibold">
              Backup file (.zip or .wpbackup)
              <input type="file" required onChange={e => setRestoreFile(e.target.files?.[0] || null)} className="mt-1 block text-xs" />
            </label>
            <label className="font-semibold">
              Decryption password (if snapshot was encrypted)
              <input type="password" value={restorePass} onChange={e => setRestorePass(e.target.value)} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring font-mono" />
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 font-semibold cursor-pointer">
              <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} />
              <span>Dry run (validate only, no changes)</span>
            </label>
            <button type="submit" disabled className="touch-target px-5 py-2 font-bold rounded-xl bg-[#D58240] text-white hover:bg-[#b86d30] disabled:opacity-50 focus-ring">
              {restoring ? "Processing…" : "Restore unavailable"}
            </button>
          </div>
        </form>
        {restoreResult && (
          <div className={`p-3 rounded-xl ${restoreResult.ok ? "bg-emerald-500/15 border border-emerald-500/30 text-emerald-600 dark:text-emerald-300" : "bg-rose-500/15 border border-rose-500/30 text-rose-600 dark:text-rose-300"}`}>
            <div className="font-bold">{restoreResult.ok ? (restoreResult.dryRun ? "Dry run: snapshot is valid" : "Restore succeeded") : "Validation failed"}</div>
            {restoreResult.entries && <div className="text-[11px] font-mono mt-1">entries: {restoreResult.entries.join(", ")}</div>}
            {restoreResult.safetyBackup && <div className="text-[11px] mt-1">Safety backup: {restoreResult.safetyBackup}</div>}
            {restoreResult.error && <div className="text-[11px] font-bold mt-1">{restoreResult.error}</div>}
          </div>
        )}
      </section>

      {/* CSV & JSON portability */}
      <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4 text-xs">
        <h2 className="text-sm font-bold flex items-center gap-2"><Shield size={16} className="text-[#5A92C9]" /> CSV & JSON portability</h2>
        <div className="flex flex-wrap gap-2">
          <a href="/api/v1/metrics/export" className="px-3 py-2 rounded-xl border border-border font-semibold hover:bg-muted inline-flex items-center gap-1.5 text-foreground">
            <Download size={13} /> Metrics CSV (formula-safe)
          </a>
          <a href="/api/v1/admin/audit/export" className="px-3 py-2 rounded-xl border border-border font-semibold hover:bg-muted inline-flex items-center gap-1.5 text-foreground">
            <Download size={13} /> Audit CSV
          </a>
          <button type="button" onClick={exportConfig} className="px-3 py-2 rounded-xl border border-border font-semibold hover:bg-muted inline-flex items-center gap-1.5">
            <Download size={13} /> JSON config schema
          </button>
        </div>
        <div>
          <label className="font-semibold block mb-1">Import JSON config schema (branding / email / SIEM)</label>
          <textarea rows={3} value={configText} onChange={e => setConfigText(e.target.value)} placeholder='{"branding":{...},"email":{...}}' className="w-full px-3 py-2 rounded-xl border border-border bg-background font-mono text-[11px] focus-ring" />
          <button type="button" onClick={importConfig} disabled={!configText.trim()} className="mt-2 px-4 py-1.5 font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] disabled:opacity-40 focus-ring">
            Apply config
          </button>
          {configResult && <p className={`mt-2 font-semibold ${configResult.ok ? "text-emerald-500" : "text-rose-500"}`}>{configResult.ok ? "Config applied." : configResult.error}</p>}
        </div>
      </section>
    </div>
  );
}
