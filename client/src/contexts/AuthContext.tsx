import React, { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from "react";

export type Role = "super_admin" | "admin" | "manager" | "view_only";
type AuthStage = "full" | "mfa_verify" | "mfa_enroll" | "password_change" | "recovery_codes" | "anonymous";

export interface User {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  status: "invited" | "active" | "disabled" | "locked";
  tenant_id: string | null;
  auth_provider: "local" | "sso";
  mfa_required: number;
  mfa_enrolled_at: string | null;
  last_signed_in_at: string | null;
  created_at: string;
}

interface AuthContextType {
  user: User | null;
  stage: AuthStage;
  userId: string | null;
  csrf: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<{ stage: string; error?: string; retryAfter?: string }>;
  startMfaEnroll: () => Promise<{ uri: string; manualSecret: string }>;
  verifyMfa: (code: string, recoveryCode?: string) => Promise<{ ok: boolean; error?: string; recoveryCodes?: string[] }>;
  recoveryCodes: string[] | null;
  finishMfaRecoveryCodes: () => void;
  changeInitialPassword: (currentPassword: string, newPassword: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  isSuperAdmin: boolean;
  isAdmin: boolean;
  isManager: boolean;
  isViewOnly: boolean;
  canEdit: boolean;
  canManageUsers: boolean;
}

type PendingMfaSession = { stage: "full" | "password_change"; user: User | null; userId: string | null; csrf: string | null };
const AuthContext = createContext<AuthContextType | undefined>(undefined);

function csrfHeader(csrf: string | null): Record<string, string> {
  return csrf ? { "x-csrf-token": csrf } : {};
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [stage, setStage] = useState<AuthStage>("anonymous");
  const [userId, setUserId] = useState<string | null>(null);
  const [csrf, setCsrf] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // One-time secrets and the verified next stage stay in memory only.
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const pendingMfaSession = useRef<PendingMfaSession | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/auth/session");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setCsrf(data.csrf || null);
      const sessionUser = data.stage === "full" ? data.user || null : null;
      const sessionUserId = sessionUser?.id || data.userId || null;
      if (pendingMfaSession.current && (data.stage === "full" || data.stage === "password_change")) {
        // A background session check must not dismiss unacknowledged recovery codes.
        pendingMfaSession.current = { stage: data.stage, user: sessionUser, userId: sessionUserId, csrf: data.csrf || null };
        setStage("recovery_codes");
        setUser(null);
      } else {
        pendingMfaSession.current = null;
        setRecoveryCodes(null);
        setStage(data.stage || "anonymous");
        setUser(sessionUser);
      }
      setUserId(sessionUserId);
    } catch {
      pendingMfaSession.current = null;
      setRecoveryCodes(null);
      setUser(null);
      setStage("anonymous");
      setUserId(null);
      setCsrf(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) return { stage: "anonymous", error: data.error, retryAfter: data.retryAfter };
    pendingMfaSession.current = null;
    setRecoveryCodes(null);
    if (data.stage === "full") {
      setUser(data.user);
      setStage("full");
      setUserId(data.user.id);
      await refresh();
      return { stage: "full" };
    }
    setCsrf(data.csrf || null);
    setUser(null);
    setStage(data.stage);
    setUserId(data.userId);
    return { stage: data.stage };
  }, [refresh]);

  const startMfaEnroll = useCallback(async () => {
    const res = await fetch("/api/v1/auth/mfa/enroll", { method: "POST", headers: csrfHeader(csrf) });
    if (!res.ok) throw new Error("MFA enrollment initialization failed");
    return res.json();
  }, [csrf]);

  const verifyMfa = useCallback(async (code: string, recoveryCode?: string) => {
    const res = await fetch("/api/v1/auth/mfa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeader(csrf) },
      body: JSON.stringify({ code, recoveryCode }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error };
    setCsrf(data.csrf || null);
    setUserId(data.userId || data.user?.id || null);
    if (data.recoveryCodes?.length && (data.stage === "full" || data.stage === "password_change")) {
      pendingMfaSession.current = {
        stage: data.stage, user: data.stage === "full" ? data.user || null : null,
        userId: data.userId || data.user?.id || null, csrf: data.csrf || null,
      };
      setRecoveryCodes(data.recoveryCodes);
      setUser(null);
      setStage("recovery_codes");
    } else {
      pendingMfaSession.current = null;
      setRecoveryCodes(null);
      setUser(data.stage === "full" ? data.user : null);
      setStage(data.stage);
    }
    return { ok: true, recoveryCodes: data.recoveryCodes };
  }, [csrf]);

  const finishMfaRecoveryCodes = useCallback(() => {
    const pending = pendingMfaSession.current;
    if (!pending) return;
    pendingMfaSession.current = null;
    setRecoveryCodes(null);
    setUser(pending.user);
    setUserId(pending.userId);
    setCsrf(pending.csrf);
    setStage(pending.stage);
  }, []);

  const changeInitialPassword = useCallback(async (currentPassword: string, newPassword: string) => {
    if (pendingMfaSession.current) return { ok: false, error: "RECOVERY_CODES_NOT_ACKNOWLEDGED" };
    const res = await fetch("/api/v1/auth/password", {
      method: "POST", headers: { "Content-Type": "application/json", ...csrfHeader(csrf) },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error };
    setCsrf(data.csrf || null);
    setUser(data.stage === "full" ? data.user : null);
    setUserId(data.userId || data.user?.id || null);
    setStage(data.stage);
    return { ok: true };
  }, [csrf]);

  const logout = useCallback(async () => {
    // Remove one-time secrets immediately, even if the network is unavailable.
    pendingMfaSession.current = null;
    setRecoveryCodes(null);
    await fetch("/api/v1/auth/logout", {
      method: "POST",
      headers: { ...csrfHeader(csrf) },
    }).catch(() => {});
    setUser(null);
    setStage("anonymous");
    setUserId(null);
    setCsrf(null);
  }, [csrf]);

  const isSuperAdmin = user?.role === "super_admin";
  const isAdmin = user?.role === "admin";
  const isManager = user?.role === "manager";
  const isViewOnly = user?.role === "view_only";
  const canEdit = isSuperAdmin || isAdmin || isManager;
  const canManageUsers = isSuperAdmin || isAdmin;

  const value = useMemo(() => ({
    user, stage, userId, csrf, loading, refresh, login, startMfaEnroll, verifyMfa, recoveryCodes, finishMfaRecoveryCodes, changeInitialPassword, logout,
    isSuperAdmin, isAdmin, isManager, isViewOnly, canEdit, canManageUsers,
  }), [user, stage, userId, csrf, loading, refresh, login, startMfaEnroll, verifyMfa, recoveryCodes, finishMfaRecoveryCodes, changeInitialPassword, logout, isSuperAdmin, isAdmin, isManager, isViewOnly, canEdit, canManageUsers]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
