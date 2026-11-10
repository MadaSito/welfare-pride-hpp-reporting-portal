import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from "react";

export type Role = "super_admin" | "admin" | "manager" | "view_only";

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
  stage: "full" | "mfa_verify" | "mfa_enroll" | "anonymous";
  userId: string | null;
  csrf: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<{ stage: string; error?: string; retryAfter?: string }>;
  startMfaEnroll: () => Promise<{ uri: string; manualSecret: string }>;
  verifyMfa: (code: string, recoveryCode?: string) => Promise<{ ok: boolean; error?: string; recoveryCodes?: string[] }>;
  logout: () => Promise<void>;
  isSuperAdmin: boolean;
  isAdmin: boolean;
  isManager: boolean;
  isViewOnly: boolean;
  canEdit: boolean;
  canManageUsers: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function csrfHeader(csrf: string | null): Record<string, string> {
  return csrf ? { "x-csrf-token": csrf } : {};
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [stage, setStage] = useState<"full" | "mfa_verify" | "mfa_enroll" | "anonymous">("anonymous");
  const [userId, setUserId] = useState<string | null>(null);
  const [csrf, setCsrf] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/auth/session");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setStage(data.stage || "anonymous");
      setCsrf(data.csrf || null);
      if (data.stage === "full" && data.user) {
        setUser(data.user);
        setUserId(data.user.id);
      } else {
        setUser(null);
        setUserId(data.userId || null);
      }
    } catch {
      setUser(null);
      setStage("anonymous");
      setUserId(null);
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
    if (data.stage === "full") {
      setUser(data.user);
      setStage("full");
      setUserId(data.user.id);
      await refresh();
      return { stage: "full" };
    }
    setStage(data.stage);
    setUserId(data.userId);
    return { stage: data.stage };
  }, [refresh]);

  const startMfaEnroll = useCallback(async () => {
    const res = await fetch("/api/v1/auth/mfa/enroll", { method: "POST" });
    if (!res.ok) throw new Error("MFA enrollment initialization failed");
    return res.json();
  }, []);

  const verifyMfa = useCallback(async (code: string, recoveryCode?: string) => {
    const res = await fetch("/api/v1/auth/mfa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, recoveryCode }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error };
    setUser(data.user);
    setStage("full");
    setUserId(data.user?.id || null);
    await refresh();
    return { ok: true, recoveryCodes: data.recoveryCodes };
  }, [refresh]);

  const logout = useCallback(async () => {
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
    user, stage, userId, csrf, loading, refresh, login, startMfaEnroll, verifyMfa, logout,
    isSuperAdmin, isAdmin, isManager, isViewOnly, canEdit, canManageUsers,
  }), [user, stage, userId, csrf, loading, refresh, login, startMfaEnroll, verifyMfa, logout, isSuperAdmin, isAdmin, isManager, isViewOnly, canEdit, canManageUsers]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
