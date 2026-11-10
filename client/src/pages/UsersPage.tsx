import React, { useEffect, useState } from "react";
import { useAuth, Role } from "../contexts/AuthContext";
import {
  Users,
  UserPlus,
  ShieldAlert,
  KeyRound,
  Mail,
  Copy,
  Check,
  Ban,
  RotateCcw,
  RefreshCcw,
  Sparkles,
  HelpCircle,
  AlertCircle,
  CheckCircle,
} from "lucide-react";

interface AdminUser {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  status: "invited" | "active" | "disabled" | "locked";
  auth_provider: "local" | "sso";
  mfa_required: number;
  mfa_enrolled_at: string | null;
  last_signed_in_at: string | null;
  created_at: string;
}

const ROLES: { id: Role; label: string; desc: string }[] = [
  { id: "super_admin", label: "Super Admin", desc: "Full control, global configuration, manages all users" },
  { id: "admin", label: "Admin", desc: "Manages users/reports/audit; isolated from Super Admin accounts" },
  { id: "manager", label: "Manager", desc: "Enters metrics, creates and draft-publishes reports" },
  { id: "view_only", label: "View Only", desc: "Read-only access to explicitly published dashboards" },
];

export function UsersPage() {
  const { csrf, isSuperAdmin, isAdmin } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // Create form
  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<Role>("manager");
  const [mfaRequired, setMfaRequired] = useState(true);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Invite
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("view_only");
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/admin/users");
      if (res.ok) {
        const d = await res.json();
        setUsers(d.users || []);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchUsers(); }, []);

  const availableRoles = ROLES.filter(r => isSuperAdmin ? true : r.id === "manager" || r.id === "view_only");

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    setTempPassword(null);
    const res = await fetch("/api/v1/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: JSON.stringify({ email, displayName, role, mfaRequired }),
    });
    const d = await res.json();
    if (res.ok) {
      setTempPassword(d.temporaryPassword);
      setEmail("");
      setDisplayName("");
      setMessage({ type: "ok", text: "User created with a one-time temporary password. MFA enrollment is enforced at first sign-in." });
      fetchUsers();
    } else {
      setMessage({ type: "err", text: d.error || "Creation failed" });
    }
  };

  const setStatus = async (id: string, status: "active" | "disabled") => {
    const res = await fetch(`/api/v1/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: JSON.stringify({ status }),
    });
    if (res.ok) fetchUsers();
  };

  const changeRole = async (id: string, r: Role) => {
    const res = await fetch(`/api/v1/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: JSON.stringify({ role: r }),
    });
    if (res.ok) fetchUsers();
  };

  const resetMfa = async (id: string) => {
    if (!confirm("Reset MFA for this user? They will be required to re-enroll at next sign-in.")) return;
    const res = await fetch(`/api/v1/admin/users/${id}/reset-mfa`, {
      method: "POST",
      headers: { ...(csrf ? { "x-csrf-token": csrf } : {}) },
    });
    if (res.ok) {
      setMessage({ type: "ok", text: "MFA reset." });
      fetchUsers();
    }
  };

  const convertSso = async (id: string, provider: "sso" | "local") => {
    const res = await fetch(`/api/v1/admin/users/${id}/convert-sso`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: JSON.stringify({ provider }),
    });
    if (res.ok) {
      setMessage({ type: "ok", text: provider === "sso" ? "Converted to Entra ID SSO user (local MFA bypassed)." : "Converted to local user (MFA re-enforced)." });
      fetchUsers();
    }
  };

  const createInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviteLink(null);
    const res = await fetch("/api/v1/admin/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    const d = await res.json();
    if (res.ok) {
      setInviteLink(d.link);
      setInviteEmail("");
      setMessage({ type: "ok", text: "Invitation link created (valid 72 hours). Deliver it through a verified channel." });
    }
  };

  const roleColor: Record<string, string> = {
    super_admin: "bg-purple-500/15 text-purple-600 dark:text-purple-300 border-purple-500/30",
    admin: "bg-blue-500/15 text-blue-600 dark:text-blue-300 border-blue-500/30",
    manager: "bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30",
    view_only: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/30",
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">User Administration</h1>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#5A92C9]/15 text-[#5A92C9] border border-[#5A92C9]/30">Module 1</span>
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
            4-tier RBAC with Super Admin account isolation, enforceable MFA, expiring invitations, and Entra ID SSO conversion.
          </p>
        </div>
        <button
          onClick={() => { setCreateOpen(!createOpen); setTempPassword(null); }}
          className="touch-target inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] focus-ring"
        >
          <UserPlus size={14} /> {createOpen ? "Close form" : "Create user"}
        </button>
      </div>

      {message && (
        <div className={`p-3 rounded-xl text-xs flex items-center gap-2 ${message.type === "ok" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30" : "bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30"}`}>
          {message.type === "ok" ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          {message.text}
        </div>
      )}

      {/* Create user form */}
      {createOpen && (
        <form onSubmit={createUser} className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-4">
          <h2 className="text-sm font-bold">New user</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            <label className="font-semibold">
              Email
              <input type="email" required value={email} onChange={e => setEmail(e.target.value)} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background font-semibold focus-ring" placeholder="user@org.org" />
            </label>
            <label className="font-semibold">
              Display name
              <input type="text" required value={displayName} onChange={e => setDisplayName(e.target.value)} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background font-semibold focus-ring" placeholder="Jane Doe" />
            </label>
            <label className="font-semibold">
              Role
              <select value={role} onChange={e => setRole(e.target.value as Role)} className="mt-1 w-full h-10 px-3 rounded-xl border border-border bg-background font-semibold focus-ring">
                {availableRoles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </label>
            <label className="font-semibold flex items-center gap-2 mt-6 cursor-pointer">
              <input type="checkbox" checked={mfaRequired} onChange={e => setMfaRequired(e.target.checked)} />
              <span>Enforce MFA at first sign-in</span>
            </label>
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" className="touch-target px-4 py-2 text-xs font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] focus-ring">
              Create and issue temporary password
            </button>
            <span className="text-[11px] text-muted-foreground">Passwords meet the 14-character complexity policy automatically.</span>
          </div>

          {tempPassword && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs space-y-1">
              <div className="font-bold text-amber-500">One-time temporary password (copy now):</div>
              <div className="font-mono text-sm break-all font-bold select-all">{tempPassword}</div>
              <button
                type="button"
                onClick={() => { navigator.clipboard.writeText(tempPassword); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#5A92C9] hover:underline"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy to clipboard"}
              </button>
            </div>
          )}
        </form>
      )}

      {/* User list */}
      <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold tracking-tight flex items-center gap-2">
            <Users size={16} className="text-[#5A92C9]" /> Accounts ({users.length})
          </h2>
          {isAdmin && !isSuperAdmin && (
            <span className="text-[11px] text-muted-foreground flex items-center gap-1">
              <ShieldAlert size={12} className="text-purple-400" /> Super Admin accounts are isolated from this view
            </span>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left border-collapse">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="py-2 px-2">User</th>
                <th className="py-2 px-2">Role</th>
                <th className="py-2 px-2">Auth</th>
                <th className="py-2 px-2">MFA</th>
                <th className="py-2 px-2">Status</th>
                <th className="py-2 px-2">Last sign-in</th>
                <th className="py-2 px-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-b border-border/60 hover:bg-muted/40">
                  <td className="py-2 px-2">
                    <div className="font-semibold">{u.display_name}</div>
                    <div className="text-muted-foreground text-[11px]">{u.email}</div>
                  </td>
                  <td className="py-2 px-2">
                    {isAdmin && u.role === "admin" ? (
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${roleColor[u.role]}`}>Admin</span>
                    ) : (
                      <select
                        value={u.role}
                        onChange={e => changeRole(u.id, e.target.value as Role)}
                        disabled={!isSuperAdmin && u.role !== "manager" && u.role !== "view_only"}
                        className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border bg-card ${roleColor[u.role]}`}
                      >
                        {availableRoles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="py-2 px-2">
                    <span className="font-mono uppercase text-[10px]">{u.auth_provider}</span>
                    {isSuperAdmin && (
                      <button
                        onClick={() => convertSso(u.id, u.auth_provider === "sso" ? "local" : "sso")}
                        className="ml-2 text-[10px] text-[#5A92C9] hover:underline"
                        title="Toggle Local <-> Entra ID SSO"
                      >
                        convert
                      </button>
                    )}
                  </td>
                  <td className="py-2 px-2">
                    {u.mfa_enrolled_at ? (
                      <span className="text-emerald-500 font-semibold">enrolled</span>
                    ) : u.mfa_required ? (
                      <span className="text-amber-500 font-semibold">required</span>
                    ) : (
                      <span className="text-muted-foreground">optional</span>
                    )}
                  </td>
                  <td className="py-2 px-2">
                    <span className={`text-[11px] font-semibold ${u.status === "active" ? "text-emerald-500" : u.status === "locked" ? "text-rose-500" : "text-muted-foreground"}`}>
                      {u.status}
                    </span>
                  </td>
                  <td className="py-2 px-2 text-muted-foreground text-[11px]">
                    {u.last_signed_in_at ? new Date(u.last_signed_in_at).toLocaleDateString() : "never"}
                  </td>
                  <td className="py-2 px-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => setStatus(u.id, u.status === "active" ? "disabled" : "active")}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                        title={u.status === "active" ? "Disable" : "Enable"}
                      >
                        <Ban size={13} />
                      </button>
                      <button
                        onClick={() => resetMfa(u.id)}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                        title="Reset MFA"
                      >
                        <RotateCcw size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Invitations */}
      <section className="rounded-2xl bg-card border border-border p-5 panel-shadow space-y-3">
        <h2 className="text-sm font-bold tracking-tight flex items-center gap-2">
          <Mail size={16} className="text-[#5A92C9]" /> Expiring invitation links (72-hour TTL)
        </h2>
        <form onSubmit={createInvite} className="flex flex-col sm:flex-row gap-2 text-xs">
          <input
            type="email"
            required
            value={inviteEmail}
            onChange={e => setInviteEmail(e.target.value)}
            placeholder="invitee@organization.org"
            className="flex-1 h-10 px-3 rounded-xl border border-border bg-background font-semibold focus-ring"
          />
          <select
            value={inviteRole}
            onChange={e => setInviteRole(e.target.value as Role)}
            className="h-10 px-3 rounded-xl border border-border bg-background font-semibold focus-ring"
          >
            {availableRoles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <button type="submit" className="touch-target px-4 py-2 font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] focus-ring">
            Create invite link
          </button>
        </form>
        {inviteLink && (
          <div className="rounded-xl border border-border bg-muted/40 p-3 text-xs space-y-1">
            <div className="font-mono text-[11px] break-all select-all">{inviteLink}</div>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(inviteLink)}
              className="text-[11px] font-semibold text-[#5A92C9] hover:underline"
            >
              Copy invite link
            </button>
          </div>
        )}
      </section>

      {/* Password policy guidance */}
      <aside className="rounded-2xl border border-border bg-card p-5 panel-shadow text-xs space-y-2">
        <h3 className="font-bold flex items-center gap-1.5"><HelpCircle size={14} className="text-[#D58240]" /> Enterprise password policy</h3>
        <p className="text-muted-foreground">
          Local passwords require at least 14 characters, uppercase and lowercase letters, two numbers, and three symbols. Accounts lock for 15 minutes after 5 consecutive failures.
        </p>
        <p className="text-[11px] text-muted-foreground font-mono">
          Example compliant format: Correct-Horse-Battery-Staple#99!
        </p>
      </aside>
    </div>
  );
}
