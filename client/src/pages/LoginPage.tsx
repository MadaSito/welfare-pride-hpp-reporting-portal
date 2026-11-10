import React, { useState, useEffect, useRef } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useBranding } from "../contexts/BrandingContext";
import { Lock, Mail, KeyRound, Shield, AlertCircle, CheckCircle, Copy, Check, Eye, EyeOff, Sparkles, HelpCircle } from "lucide-react";
import QRCode from "qrcode";

export function LoginPage() {
  const { stage, login, startMfaEnroll, verifyMfa, isSuperAdmin } = useAuth();
  const { brand } = useBranding();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // MFA verify
  const [mfaCode, setMfaCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");

  // MFA enroll
  const [enrollData, setEnrollData] = useState<{ uri: string; manualSecret: string } | null>(null);
  const qrRef = useRef<HTMLCanvasElement | null>(null);
  const [enrollCode, setEnrollCode] = useState("");
  const [enrollCodesIssued, setEnrollCodesIssued] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [qrError, setQrError] = useState(false);

  // Forgot password
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotMsg, setForgotMsg] = useState<string | null>(null);

  const companyName = brand?.company_name || "Welfare Pride";
  const iconUrl = brand?.icon_url || "/assets/branding/welfare-pride-icon.png";

  const onCredSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await login(email, password);
    setBusy(false);
    if (r.error) setError(r.error === "ACCOUNT_LOCKED" ? "Account temporarily locked after too many failed attempts. Try again in 15 minutes." : "Invalid email or password.");
  };

  useEffect(() => {
    if (stage === "mfa_enroll" && !enrollData) {
      startMfaEnroll().then(setEnrollData).catch(() => setError("Failed to start MFA enrollment"));
    }
  }, [stage, enrollData, startMfaEnroll]);

  useEffect(() => {
    if (enrollData && qrRef.current) {
      QRCode.toCanvas(qrRef.current, enrollData.uri, { width: 200, margin: 1 }, (err) => {
        if (err) setQrError(true);
      });
    }
  }, [enrollData]);

  const onVerifySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = useRecovery ? await verifyMfa("", recoveryCode) : await verifyMfa(mfaCode);
    setBusy(false);
    if (!r.ok) setError(useRecovery ? "Invalid or already-used recovery code." : "Invalid authenticator code. Codes rotate every 30 seconds.");
  };

  const onEnrollSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await verifyMfa(enrollCode);
    setBusy(false);
    if (!r.ok) setError("Invalid code. Enter the 6 digits currently shown in your authenticator app.");
    else if (r.recoveryCodes) setEnrollCodesIssued(r.recoveryCodes);
  };

  const onForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setForgotMsg(null);
    const res = await fetch("/api/v1/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: forgotEmail }),
    });
    setForgotMsg("If an account exists for that email, a password-reset link has been sent (local accounts only; SSO accounts reset in Microsoft Entra ID).");
  };

  const demoAccounts = [
    { label: "Super Admin", e: "superadmin@welfarepride.org", role: "super_admin" },
    { label: "Admin", e: "admin@welfarepride.org", role: "admin" },
    { label: "Manager", e: "manager@welfarepride.org", role: "manager" },
    { label: "View Only", e: "viewer@welfarepride.org", role: "view_only" },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col justify-center py-10 px-4 sm:px-6 brand-grid">
      <div className="mx-auto w-full max-w-md space-y-6">
        {/* Brand header */}
        <div className="text-center space-y-2">
          <img src={iconUrl} alt="" className="mx-auto h-14 w-14 rounded-full object-cover shadow-lg shadow-[#5A92C9]/20" />
          <h1 className="text-2xl font-bold tracking-tight">{companyName}</h1>
          <p className="text-xs text-muted-foreground">{brand?.tagline || "HPP Reporting Portal"}</p>
        </div>

        {/* Card */}
        <div className="rounded-2xl bg-card border border-border p-6 sm:p-7 panel-shadow space-y-5">
          {stage === "mfa_enroll" ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Shield className="text-[#5A92C9]" size={20} />
                <h2 className="text-base font-bold">First-time sign-in: enroll MFA</h2>
              </div>
              <p className="text-xs text-muted-foreground">
                Your role requires multi-factor authentication. Scan the QR code with any TOTP authenticator app (Microsoft Authenticator, Google Authenticator, etc.), or manually enter the secret key.
              </p>
              <div className="flex flex-col items-center gap-3">
                <canvas ref={qrRef} className="rounded-xl border border-border bg-white p-2" />
                {qrError && <p className="text-[11px] text-rose-500">QR rendering unavailable — use manual entry below.</p>}
                {enrollData && (
                  <div className="text-center">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wider block">Manual secret key</span>
                    <span className="font-mono text-xs font-bold select-all break-all">{enrollData.manualSecret}</span>
                  </div>
                )}
              </div>
              {enrollCodesIssued ? (
                <div className="space-y-3 rounded-xl border border-border bg-muted/40 p-4 text-xs">
                  <div className="font-bold flex items-center gap-1.5"><CheckCircle className="text-emerald-500" size={14} /> MFA enrolled. Save your recovery codes</div>
                  <p className="text-[11px] text-muted-foreground">Store these 8 one-time recovery codes in a safe place. They will never be shown again.</p>
                  <div className="grid grid-cols-2 gap-1 font-mono text-[11px] font-bold select-all">
                    {enrollCodesIssued.map(c => <div key={c}>{c}</div>)}
                  </div>
                  <button
                    type="button"
                    onClick={() => { navigator.clipboard.writeText(enrollCodesIssued.join("\n")); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#5A92C9] hover:underline"
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy all codes"}
                  </button>
                  <a href="/" className="block text-center mt-2 px-4 py-2 font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3]">
                    Continue to portal
                  </a>
                </div>
              ) : (
                <form onSubmit={onEnrollSubmit} className="space-y-3 text-xs">
                  <label className="font-semibold block">
                    Enter the current 6-digit code to confirm
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      required
                      autoFocus
                      value={enrollCode}
                      onChange={e => setEnrollCode(e.target.value.replace(/\D/g, ""))}
                      className="mt-1 w-full h-11 px-3 rounded-xl border border-border bg-background text-center text-xl tracking-widest font-mono font-bold focus-ring"
                      placeholder="000000"
                    />
                  </label>
                  {error && <div className="p-3 rounded-xl bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30 text-xs flex items-center gap-2"><AlertCircle size={14} />{error}</div>}
                  <button type="submit" disabled={busy || enrollCode.length !== 6} className="touch-target w-full py-2.5 font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] disabled:opacity-50 focus-ring">
                    Confirm & enroll MFA
                  </button>
                </form>
              )}
            </div>
          ) : stage === "mfa_verify" ? (
            <form onSubmit={onVerifySubmit} className="space-y-4">
              <div className="flex items-center gap-2">
                <Shield className="text-[#5A92C9]" size={20} />
                <h2 className="text-base font-bold">Two-step verification</h2>
              </div>
              <p className="text-xs text-muted-foreground">
                Enter the 6-digit code from your authenticator app, or use a one-time recovery code.
              </p>
              {!useRecovery ? (
                <label className="font-semibold block text-xs">
                  Authenticator code
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    autoFocus
                    value={mfaCode}
                    onChange={e => setMfaCode(e.target.value.replace(/\D/g, ""))}
                    className="mt-1 w-full h-12 px-3 rounded-xl border border-border bg-background text-center text-2xl tracking-widest font-mono font-bold focus-ring"
                    placeholder="000000"
                  />
                </label>
              ) : (
                <label className="font-semibold block text-xs">
                  Recovery code
                  <input
                    type="text"
                    required
                    autoFocus
                    value={recoveryCode}
                    onChange={e => setRecoveryCode(e.target.value.toUpperCase())}
                    className="mt-1 w-full h-11 px-3 rounded-xl border border-border bg-background text-center font-mono font-bold tracking-wider focus-ring text-sm"
                    placeholder="XXXX-XXXX"
                  />
                </label>
              )}
              {error && <div className="p-3 rounded-xl bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30 text-xs flex items-center gap-2"><AlertCircle size={14} />{error}</div>}
              <button type="submit" disabled={busy} className="touch-target w-full py-2.5 font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] disabled:opacity-50 focus-ring text-xs">
                {busy ? "Verifying…" : "Verify and sign in"}
              </button>
              <div className="text-center text-xs">
                <button type="button" onClick={() => setUseRecovery(!useRecovery)} className="font-semibold text-[#5A92C9] hover:underline">
                  {useRecovery ? "Use authenticator code instead" : "Trouble signing in? Use recovery code"}
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={onCredSubmit} className="space-y-4">
              <div className="space-y-1">
                <h2 className="text-base font-bold">Sign in</h2>
                <p className="text-xs text-muted-foreground">Local accounts with MFA; Microsoft Entra ID single sign-on also supported.</p>
              </div>
              <label className="font-semibold block text-xs">
                Email
                <div className="relative mt-1">
                  <Mail size={14} className="absolute left-3 top-3 text-muted-foreground" />
                  <input
                    type="email"
                    required
                    autoFocus
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="you@organization.org"
                    className="w-full h-11 pl-9 pr-3 rounded-xl border border-border bg-background font-semibold focus-ring text-xs"
                  />
                </div>
              </label>
              <label className="font-semibold block text-xs">
                Password
                <div className="relative mt-1">
                  <KeyRound size={14} className="absolute left-3 top-3 text-muted-foreground" />
                  <input
                    type={showPass ? "text" : "password"}
                    required
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="w-full h-11 pl-9 pr-9 rounded-xl border border-border bg-background font-semibold focus-ring text-xs"
                  />
                  <button type="button" onClick={() => setShowPass(!showPass)} className="absolute right-3 top-3 text-muted-foreground hover:text-foreground">
                    {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </label>
              <div className="flex justify-between items-center text-xs">
                <span className="text-muted-foreground text-[11px]">14-char policy enforced</span>
                <button type="button" onClick={() => setForgotOpen(true)} className="font-semibold text-[#5A92C9] hover:underline">Forgot password?</button>
              </div>
              {error && <div className="p-3 rounded-xl bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30 text-xs flex items-center gap-2"><AlertCircle size={14} />{error}</div>}
              <button type="submit" disabled={busy} className="touch-target w-full py-2.5 font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] disabled:opacity-50 focus-ring text-xs">
                {busy ? "Signing in…" : "Sign in"}
              </button>
              <div className="relative my-1 text-center text-xs text-muted-foreground"><span className="bg-card px-2">or</span></div>
              <a href="/api/v1/auth/sso/entra" className="touch-target w-full py-2.5 font-bold rounded-xl border border-border bg-card hover:bg-muted text-xs flex items-center justify-center gap-2 text-foreground">
                <span className="text-[13px] font-black tracking-tight" style={{ color: "#00a4ef" }}>■</span>
                <span>Sign in with Microsoft Entra ID</span>
              </a>
            </form>
          )}
        </div>

        {/* Demo accounts */}
        <div className="rounded-2xl border border-border bg-card p-4 panel-shadow text-xs space-y-2">
          <div className="font-bold flex items-center gap-1.5"><Sparkles size={14} className="text-[#D58240]" /> Demo accounts (first-time evaluation)</div>
          <p className="text-[11px] text-muted-foreground">Passwords are set in the repo README / deployment guide. Pick an account to fill its email:</p>
          <div className="flex flex-wrap gap-1">
            {demoAccounts.map(a => (
              <button key={a.e} type="button" onClick={() => setEmail(a.e)} className="px-2.5 py-1 rounded-full border border-border bg-background hover:bg-muted font-semibold text-[11px]">
                {a.label}
              </button>
            ))}
          </div>
        </div>

        {/* Forgot password dialog */}
        {forgotOpen && (
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-2xl bg-card border border-border p-6 shadow-2xl space-y-3 text-xs">
              <h2 className="text-base font-bold">Reset password</h2>
              <p className="text-muted-foreground">Local-account users receive an expiring reset link. Entra ID SSO users reset credentials in Microsoft.</p>
              <form onSubmit={onForgotSubmit} className="space-y-3">
                <input type="email" required value={forgotEmail} onChange={e => setForgotEmail(e.target.value)} placeholder="you@organization.org" className="w-full h-10 px-3 rounded-xl border border-border bg-background focus-ring" />
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => { setForgotOpen(false); setForgotMsg(null); }} className="px-3 py-1.5 rounded-xl border border-border hover:bg-muted font-semibold">Cancel</button>
                  <button type="submit" className="px-4 py-1.5 font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3]">Send link</button>
                </div>
              </form>
              {forgotMsg && <p className="text-[11px] text-muted-foreground font-semibold">{forgotMsg}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
