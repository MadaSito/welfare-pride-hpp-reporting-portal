import React, { useState, useEffect, useRef } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useBranding } from "../contexts/BrandingContext";
import { Mail, KeyRound, Shield, AlertCircle, CheckCircle, Copy, Check, Eye, EyeOff, Building2, Palette } from "lucide-react";
import QRCode from "qrcode";

// Capture and remove the fragment before the app waits for its initial session check.
// The token remains in memory only and is never included in a request URL.
const isMagicLinkLanding = typeof window !== "undefined" && window.location.pathname === "/magic-link";
let pendingMagicLinkToken: string | null = null;
if (isMagicLinkLanding && window.location.hash) {
  pendingMagicLinkToken = new URLSearchParams(window.location.hash.slice(1)).get("token");
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
}

export function discardPendingMagicLink() { pendingMagicLinkToken = null; }

export function LoginPage() {
  const { stage, csrf, login, startMfaEnroll, verifyMfa, changeInitialPassword, refresh, logout } = useAuth();
  const { brand, refresh: refreshBranding } = useBranding();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkToken, setLinkToken] = useState<string | null>(pendingMagicLinkToken);
  const [linkMissing, setLinkMissing] = useState(isMagicLinkLanding && !pendingMagicLinkToken);
  const [linkRequested, setLinkRequested] = useState(false);

  // First-run setup state
  const [setupNeeded, setSetupNeeded] = useState<boolean | null>(null);
  const [setupEmail, setSetupEmail] = useState("");
  const [setupName, setSetupName] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [setupConfirm, setSetupConfirm] = useState("");
  const [showSetupPass, setShowSetupPass] = useState(false);
  const [companyInput, setCompanyInput] = useState("");
  const [taglineInput, setTaglineInput] = useState("");
  const [primaryColor, setPrimaryColor] = useState("#5A92C9");
  const [secondaryColor, setSecondaryColor] = useState("#D58240");
  const [logoUrlInput, setLogoUrlInput] = useState("");

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

  const companyName = brand?.company_name || "Welfare Pride";
  const iconUrl = brand?.icon_url || "/assets/branding/welfare-pride-icon.png";
  const tagline = !brand?.tagline || brand.tagline === "Health Plan Outreach Reporting Portal"
    ? "Outreach Reporting Dashboard Portal"
    : brand.tagline;

  useEffect(() => {
    fetch("/api/v1/auth/setup/status")
      .then(r => r.json())
      .then(d => setSetupNeeded(!!d.setupNeeded))
      .catch(() => setSetupNeeded(false));
  }, []);

  const onSetupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!setupEmail.trim() || !(document.getElementById("setup-email") as HTMLInputElement | null)?.checkValidity()) {
      setError("Enter a valid email address.");
      document.getElementById("setup-email")?.focus();
      return;
    }
    if (setupPassword !== setupConfirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/v1/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: setupEmail.trim(),
          password: setupPassword,
          displayName: setupName.trim() || undefined,
          companyName: companyInput.trim() || undefined,
          tagline: taglineInput.trim() || undefined,
          primaryColor: primaryColor || undefined,
          secondaryColor: secondaryColor || undefined,
          logoUrl: logoUrlInput.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.error === "PASSWORD_POLICY") setError(data.message || "Password does not meet the policy requirements.");
        else if (data.error === "SETUP_ALREADY_COMPLETED") setError("Setup has already been completed. Please sign in instead.");
        else setError("Could not create the account. Please check your details and try again.");
        return;
      }
      setSetupNeeded(false);
      await refreshBranding();
      const loginResult = await login(setupEmail.trim(), setupPassword);
      if (loginResult.error) {
        setError("Account created, but automatic sign-in failed. Please sign in below.");
      }
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const onLinkRequest = async () => {
    if (!email.trim() || !(document.getElementById("login-email") as HTMLInputElement | null)?.checkValidity()) {
      setError("Enter a valid email address above.");
      document.getElementById("login-email")?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setLinkRequested(false);
    setLinkMissing(false);
    try {
      const res = await fetch("/api/v1/auth/magic-link/request", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!res.ok) throw new Error();
      setLinkRequested(true);
    } catch {
      setError("We couldn't complete your request. Please try again later.");
    } finally {
      setBusy(false);
    }
  };

  const onLinkContinue = async () => {
    if (!linkToken) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/auth/magic-link/consume", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: linkToken }),
      });
      if (!res.ok) throw new Error();
      pendingMagicLinkToken = null;
      setLinkToken(null);
      window.history.replaceState(window.history.state, "", "/");
      await refresh();
      setLinkMissing(true);
    } catch {
      setError("This sign-in link couldn't be used. Please request a new link and try again.");
    } finally {
      setBusy(false);
    }
  };

  const onCredSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !(document.getElementById("login-email") as HTMLInputElement | null)?.checkValidity()) {
      setError("Enter a valid email address above.");
      document.getElementById("login-email")?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await login(email, password);
      if (!r.error) setPassword("");
      else setError("Sign-in could not be completed. Check your details or try again later.");
    } catch {
      setError("Sign-in could not be completed. Check your details or try again later.");
    } finally {
      setBusy(false);
    }
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
    if (!r.ok) setError(useRecovery ? "The recovery code could not be verified. After too many attempts, wait 15 minutes and try again." : "The authenticator code could not be verified. After too many attempts, wait 15 minutes and try again.");
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

  const onPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) { setError("New passwords do not match."); return; }
    setBusy(true);
    try {
      const result = await changeInitialPassword(currentPassword, newPassword);
      if (!result.ok) setError(result.error === "INVALID_CREDENTIALS" ? "Current password is incorrect." : result.error === "PASSWORD_MUST_DIFFER" ? "Choose a different password." : "Use 14–128 characters with upper and lowercase letters, at least two digits, and three symbols.");
    } catch { setError("Password change failed. Please try again."); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col justify-center py-10 px-4 sm:px-6 brand-grid">
      <div className="mx-auto w-full max-w-md space-y-6">
        {/* Brand header */}
        <div className="text-center space-y-2">
          <div className="flex justify-center">
            <img src={iconUrl} alt={companyName} className="h-14 w-auto object-contain" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{companyName}</h1>
          <p className="text-sm font-medium text-muted-foreground">{tagline}</p>
        </div>

        <div className="bg-card rounded-2xl border border-border shadow-sm p-7 space-y-5">
          {stage === "mfa_verify" ? (
            <form onSubmit={onVerifySubmit} className="space-y-4">
              <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                <Shield size={14} /> Multi-Factor Authentication
              </div>
              <h2 className="text-xl font-bold">Verify your identity</h2>
              <p className="text-xs text-muted-foreground">Enter the 6-digit code from your authenticator app, or use a saved recovery code.</p>
              {!useRecovery ? (
                <label className="font-semibold block text-xs">
                  Authenticator code
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    autoFocus
                    maxLength={6}
                    value={mfaCode}
                    onChange={e => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    className="mt-1 w-full h-11 px-3 rounded-xl border border-border bg-background text-center font-mono text-2xl tracking-widest font-bold focus-ring"
                    placeholder="••••••"
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
              <button type="button" onClick={async () => { discardPendingMagicLink(); setLinkToken(null); setError(null); await logout(); }} className="focus-ring w-full py-2 text-xs font-semibold text-muted-foreground underline">Cancel and return to sign-in</button>
            </form>
          ) : linkToken ? (
            <div className="space-y-5">
              <div className="space-y-2">
                <h2 className="text-lg font-bold">Continue with your sign-in link</h2>
                <p className="text-sm leading-6 text-muted-foreground">Select continue to use this link. You will then need to complete multi-factor authentication before accessing the portal.</p>
              </div>
              {error && <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/15 p-3 text-sm text-rose-700 dark:text-rose-300">{error}</div>}
              <button type="button" onClick={onLinkContinue} disabled={busy} className="focus-ring touch-target w-full rounded-xl bg-[#a43f21] px-4 py-3 text-sm font-bold text-white hover:bg-[#843018] disabled:opacity-60">
                {busy ? "Continuing…" : "Continue to MFA"}
              </button>
              <button type="button" onClick={() => { pendingMagicLinkToken = null; setLinkToken(null); setError(null); window.history.replaceState(window.history.state, "", "/"); }} className="focus-ring w-full rounded-lg py-2 text-sm font-semibold text-muted-foreground underline underline-offset-4">Request a new link instead</button>
            </div>
          ) : setupNeeded ? (
            <div className="space-y-5">
              <div className="space-y-2">
                <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#5A92C9]">
                  <Shield size={14} /> First-time setup
                </div>
                <h2 className="text-xl font-bold">Create your administrator account</h2>
                <p className="text-xs text-muted-foreground">This only happens once. The account you create here will have super administrator access to the entire portal. You can invite other staff later.</p>
              </div>
              <form onSubmit={onSetupSubmit} className="space-y-3">
                <label className="block text-xs font-semibold" htmlFor="setup-email">Administrator email</label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-3.5 text-muted-foreground" size={18} />
                  <input
                    id="setup-email"
                    type="email"
                    required
                    value={setupEmail}
                    onChange={e => setSetupEmail(e.target.value)}
                    className="h-11 w-full rounded-xl border border-border bg-background pl-10 pr-3 text-sm focus-ring"
                    placeholder="admin@organization.org"
                  />
                </div>
                <label className="block text-xs font-semibold" htmlFor="setup-name">Display name (optional)</label>
                <input
                  id="setup-name"
                  type="text"
                  value={setupName}
                  onChange={e => setSetupName(e.target.value)}
                  className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm focus-ring"
                  placeholder="e.g. Morgan Chase"
                />
                <label className="block text-xs font-semibold" htmlFor="setup-pass">Password</label>
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3 top-3.5 text-muted-foreground" size={18} />
                  <input
                    id="setup-pass"
                    type={showSetupPass ? "text" : "password"}
                    required
                    minLength={14}
                    value={setupPassword}
                    onChange={e => setSetupPassword(e.target.value)}
                    className="h-11 w-full rounded-xl border border-border bg-background pl-10 pr-10 text-sm focus-ring"
                  />
                  <button type="button" onClick={() => setShowSetupPass(!showSetupPass)} className="absolute right-3 top-3.5 text-muted-foreground" tabIndex={-1} aria-label={showSetupPass ? "Hide password" : "Show password"}>
                    {showSetupPass ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
                <label className="block text-xs font-semibold" htmlFor="setup-confirm">Confirm password</label>
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3 top-3.5 text-muted-foreground" size={18} />
                  <input
                    id="setup-confirm"
                    type={showSetupPass ? "text" : "password"}
                    required
                    minLength={14}
                    value={setupConfirm}
                    onChange={e => setSetupConfirm(e.target.value)}
                    className="h-11 w-full rounded-xl border border-border bg-background pl-10 pr-3 text-sm focus-ring"
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">14–128 characters with uppercase, lowercase, at least two numbers, and three special characters.</p>

                <details className="rounded-xl border border-border bg-muted/20 p-3 text-xs">
                  <summary className="cursor-pointer font-semibold text-foreground flex items-center gap-1.5 list-none">
                    <Palette size={14} /> Customize branding (optional)
                  </summary>
                  <div className="mt-3 space-y-3 pt-1">
                    <div>
                      <label className="block text-[11px] font-semibold text-muted-foreground" htmlFor="setup-company">Company / organization name</label>
                      <input id="setup-company" type="text" value={companyInput} onChange={e => setCompanyInput(e.target.value)} placeholder="Welfare Pride" className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-3 text-xs focus-ring" />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-muted-foreground" htmlFor="setup-tagline">Portal tagline</label>
                      <input id="setup-tagline" type="text" value={taglineInput} onChange={e => setTaglineInput(e.target.value)} placeholder="Outreach Reporting Dashboard Portal" className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-3 text-xs focus-ring" />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-muted-foreground" htmlFor="setup-logo">Logo image URL</label>
                      <input id="setup-logo" type="text" value={logoUrlInput} onChange={e => setLogoUrlInput(e.target.value)} placeholder="https://… or /assets/branding/…" className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-3 text-xs focus-ring" />
                    </div>
                    <div>
                      <span className="block text-[11px] font-semibold text-muted-foreground mb-1">Color scheme (multiple hex values)</span>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[10px] text-muted-foreground block mb-0.5" htmlFor="setup-primary-hex">Primary color</label>
                          <div className="flex items-center gap-1.5">
                            <input type="color" value={primaryColor} onChange={e => setPrimaryColor(e.target.value)} className="h-8 w-10 cursor-pointer rounded border border-border bg-background" aria-label="Primary color picker" />
                            <input id="setup-primary-hex" type="text" value={primaryColor} onChange={e => setPrimaryColor(e.target.value)} className="h-8 w-full rounded border border-border bg-background px-2 font-mono text-xs uppercase focus-ring" />
                          </div>
                        </div>
                        <div>
                          <label className="text-[10px] text-muted-foreground block mb-0.5" htmlFor="setup-secondary-hex">Secondary color</label>
                          <div className="flex items-center gap-1.5">
                            <input type="color" value={secondaryColor} onChange={e => setSecondaryColor(e.target.value)} className="h-8 w-10 cursor-pointer rounded border border-border bg-background" aria-label="Secondary color picker" />
                            <input id="setup-secondary-hex" type="text" value={secondaryColor} onChange={e => setSecondaryColor(e.target.value)} className="h-8 w-full rounded border border-border bg-background px-2 font-mono text-xs uppercase focus-ring" />
                          </div>
                        </div>
                      </div>
                      <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
                        Preview: <span className="h-4 w-6 rounded" style={{ background: primaryColor }} /> primary &nbsp; <span className="h-4 w-6 rounded" style={{ background: secondaryColor }} /> secondary
                      </div>
                    </div>
                  </div>
                </details>

                {error && <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/15 p-3 text-xs text-rose-600 dark:text-rose-300"><AlertCircle size={14} />{error}</div>}
                <button type="submit" disabled={busy} className="touch-target w-full rounded-xl bg-[#5A92C9] px-4 py-3 text-sm font-bold text-white hover:bg-[#4a80b3] disabled:opacity-50 focus-ring">
                  {busy ? "Creating account…" : "Create administrator account"}
                </button>
              </form>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="space-y-2">
                <h2 className="text-lg font-bold">Sign in to your account</h2>
                <p className="text-sm leading-6 text-muted-foreground">Local accounts require multi-factor authentication.</p>
              </div>
              {linkMissing && <p role="status" className="rounded-xl border border-border bg-muted/40 p-3 text-sm">This sign-in link is unavailable. Request a new link below.</p>}
              <form onSubmit={onCredSubmit} className="space-y-3">
                <label className="block text-sm font-semibold" htmlFor="login-email">Email address</label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-3.5 text-muted-foreground" size={18} />
                  <input
                    id="login-email"
                    type="email"
                    required
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    className="h-11 w-full rounded-xl border border-border bg-background pl-10 pr-3 text-sm focus-ring"
                    placeholder="you@organization.org"
                  />
                </div>
                <label className="block text-sm font-semibold" htmlFor="login-password">Password</label>
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3 top-3.5 text-muted-foreground" size={18} />
                  <input
                    id="login-password"
                    type={showPass ? "text" : "password"}
                    required
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="h-11 w-full rounded-xl border border-border bg-background pl-10 pr-10 text-sm focus-ring"
                  />
                  <button type="button" onClick={() => setShowPass(!showPass)} className="absolute right-3 top-3.5 text-muted-foreground" tabIndex={-1} aria-label={showPass ? "Hide password" : "Show password"}>
                    {showPass ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>14-char policy enforced</span>
                  <a href="#recovery" onClick={e => { e.preventDefault(); setError("Contact an administrator to regain access. There is no self-service password reset."); }} className="hover:underline">Forgot password?</a>
                </div>
                {error && <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/15 p-3 text-xs text-rose-600 dark:text-rose-300"><AlertCircle size={14} />{error}</div>}
                <button type="submit" disabled={busy} className="touch-target w-full rounded-xl bg-[#5A92C9] px-4 py-3 text-sm font-bold text-white hover:bg-[#4a80b3] disabled:opacity-50 focus-ring">
                  {busy ? "Signing in…" : "Sign in"}
                </button>
              </form>
              <div className="space-y-2 border-t border-border pt-4">
                <button type="button" onClick={onLinkRequest} disabled={busy} className="focus-ring touch-target w-full rounded-xl bg-[#a43f21] px-4 py-3 text-sm font-bold text-white hover:bg-[#843018] disabled:opacity-60">
                  <span className="flex items-center justify-center gap-2"><Mail size={18} aria-hidden="true" /> Email me a sign-in link</span>
                </button>
                <p className="text-center text-xs leading-5 text-muted-foreground">For local accounts with MFA already set up. Open the link in the same browser, then enter your MFA code.</p>
              </div>
              {linkRequested && <div role="status" className="rounded-xl border border-emerald-700/30 bg-emerald-500/10 p-3 text-sm leading-6 text-emerald-800 dark:text-emerald-200">If the email address is eligible, you may receive a sign-in link. Please check your inbox and spam folder.</div>}
              <div className="space-y-2">
                <button type="button" disabled aria-describedby="sso-unavailable" className="touch-target w-full cursor-not-allowed rounded-xl border-2 border-[#7043a3] bg-[#663590] px-4 py-3 text-sm font-bold text-white">
                  <span className="flex items-center justify-center gap-2"><Building2 size={18} aria-hidden="true" /> Welfare Pride SSO <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs">Unavailable</span></span>
                </button>
                <p id="sso-unavailable" className="text-center text-xs leading-5 text-muted-foreground">Welfare Pride SSO is not yet available. Use another sign-in method.</p>
              </div>
              <p className="text-center text-xs text-muted-foreground">Contact an administrator for account recovery.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
