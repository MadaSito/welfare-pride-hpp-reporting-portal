import React, { useState, useEffect, useRef } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useBranding } from "../contexts/BrandingContext";
import { Mail, KeyRound, Shield, AlertCircle, CheckCircle, Copy, Check, Eye, EyeOff, Building2, Palette, Sparkles } from "lucide-react";
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

function generateStrongPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const specials = "!@#$%^*?";
  const all = upper + lower + digits + specials;
  const pick = (chars: string) => chars[Math.floor(Math.random() * chars.length)];
  const mandatory = [pick(upper), pick(upper), pick(lower), pick(lower), pick(digits), pick(digits), pick(specials), pick(specials), pick(specials)];
  const rest = Array.from({ length: 11 }, () => pick(all));
  return mandatory.concat(rest).sort(() => Math.random() - 0.5).join("");
}

export function LoginPage() {
  const { stage, csrf, login, startMfaEnroll, verifyMfa, recoveryCodes, finishMfaRecoveryCodes, changeInitialPassword, refresh, logout } = useAuth();
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

  const [copiedPass, setCopiedPass] = useState(false);
  const [generatedInfo, setGeneratedInfo] = useState<string | null>(null);
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
  const [enrollLoading, setEnrollLoading] = useState(false);
  const enrollRequested = useRef(false);
  const enrollAttempt = useRef(0);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const stageHeadingRef = useRef<HTMLHeadingElement | null>(null);
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
      setSetupPassword("");
      setSetupConfirm("");
      setGeneratedInfo(null);
      setShowSetupPass(false);
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
      const r = await login(email.trim(), password);
      if (!r.error) { setPassword(""); }
      else if (r.error === "INVALID_CREDENTIALS") setError("The email or password you entered is incorrect. Passwords are case-sensitive.");
      else if (r.error === "ACCOUNT_LOCKED") setError("This account is temporarily locked due to too many failed attempts. Please wait a few minutes and try again.");
      else if (r.error === "ACCOUNT_DISABLED") setError("This account has been disabled. Contact an administrator.");
      else if (r.error === "INVALID_CREDENTIALS_PAYLOAD") setError("Please enter a valid email address and password.");
      else setError("Sign-in could not be completed. Check your details or try again later.");
    } catch {
      setError("Sign-in could not be completed. Check your details or try again later.");
    } finally {
      setBusy(false);
    }
  };

  const loadEnrollment = async () => {
    if (enrollRequested.current) return;
    enrollRequested.current = true;
    const attempt = ++enrollAttempt.current;
    setEnrollLoading(true);
    setError(null);
    setQrError(false);
    try {
      const data = await startMfaEnroll();
      if (attempt === enrollAttempt.current && stageRef.current === "mfa_enroll") setEnrollData(data);
    } catch {
      if (attempt === enrollAttempt.current && stageRef.current === "mfa_enroll") {
        setError("Could not start authenticator setup. Please retry or return to sign-in.");
      }
    } finally {
      if (attempt === enrollAttempt.current) setEnrollLoading(false);
    }
  };

  useEffect(() => {
    if (stage === "mfa_enroll") {
      // The ref also prevents a second request when CSRF changes or Strict Mode replays effects.
      void loadEnrollment();
    } else {
      enrollAttempt.current++;
      enrollRequested.current = false;
      setEnrollData(null);
      setEnrollCode("");
      setEnrollLoading(false);
      setQrError(false);
    }
  }, [stage, startMfaEnroll]);

  useEffect(() => {
    setError(null);
    setCopied(false);
    setMfaCode("");
    setRecoveryCode("");
    setUseRecovery(false);
    if (stage !== "anonymous") { setPassword(""); setShowPass(false); }
    if (stage !== "password_change") {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    }
    stageHeadingRef.current?.focus();
  }, [stage]);

  useEffect(() => {
    if (enrollData && qrRef.current) {
      QRCode.toCanvas(qrRef.current, enrollData.uri, { width: 200, margin: 1 }, (err) => {
        if (err) setQrError(true);
      });
    }
  }, [enrollData]);

  const cancelSignIn = async () => {
    enrollAttempt.current++;
    enrollRequested.current = false;
    setEnrollData(null);
    setEnrollCode("");
    setMfaCode("");
    setRecoveryCode("");
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPassword("");
    setShowPass(false);
    setSetupPassword("");
    setSetupConfirm("");
    setGeneratedInfo(null);
    setShowSetupPass(false);
    setCopied(false);
    discardPendingMagicLink();
    setLinkToken(null);
    setError(null);
    setBusy(true);
    try { await logout(); } finally { setBusy(false); }
  };

  const onVerifySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = useRecovery ? await verifyMfa("", recoveryCode) : await verifyMfa(mfaCode);
      if (!r.ok) setError(useRecovery ? "The recovery code could not be verified. After too many attempts, wait 15 minutes and try again." : "The authenticator code could not be verified. After too many attempts, wait 15 minutes and try again.");
      else { setMfaCode(""); setRecoveryCode(""); }
    } catch { setError("Could not reach the server. Please try again."); }
    finally { setBusy(false); }
  };

  const onEnrollSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await verifyMfa(enrollCode);
      if (!r.ok) setError("Invalid code. Enter the 6 digits currently shown in your authenticator app.");
      else { setEnrollCode(""); setEnrollData(null); }
    } catch { setError("Could not reach the server. Please try again."); }
    finally { setBusy(false); }
  };

  const onPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) { setError("New passwords do not match."); return; }
    if (newPassword.length < 14 || newPassword.length > 256) { setError("Use a new password with 14–256 characters."); return; }
    setBusy(true);
    try {
      const result = await changeInitialPassword(currentPassword, newPassword);
      if (result.ok) {
        setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      } else {
        setError(result.error === "INVALID_CREDENTIALS" ? "The current or temporary password is incorrect." : result.error === "PASSWORD_MUST_DIFFER" ? "Choose a password different from your current password." : result.error === "PASSWORD_POLICY_VIOLATION" || result.error === "INVALID_PAYLOAD" ? "Use 14–256 characters and avoid known compromised passwords." : result.error === "SESSION_EXPIRED" || result.error === "AUTHENTICATION_REQUIRED" ? "Your session has expired. Return to sign-in and try again." : "Password change failed. Please try again.");
      }
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

        <div className="bg-card rounded-2xl border border-border shadow-sm p-5 sm:p-7 space-y-5">
          {stage === "mfa_enroll" ? (
            <form onSubmit={onEnrollSubmit} className="space-y-4" aria-busy={busy || enrollLoading}>
              <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                <Shield size={14} aria-hidden="true" /> Secure your account
              </div>
              <h2 ref={stageHeadingRef} tabIndex={-1} className="text-xl font-bold focus-ring rounded">Set up your authenticator</h2>
              <p className="text-sm leading-6 text-muted-foreground">Add this account to an authenticator app. You will save recovery codes next, before continuing to the portal.</p>
              {enrollLoading && <p role="status" className="text-sm text-muted-foreground">Preparing secure setup…</p>}
              {enrollData && (
                <>
                  <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-3">
                    <p className="text-sm font-semibold">1. Scan the QR code in your app</p>
                    {!qrError ? (
                      <div className="flex justify-center">
                        <canvas ref={qrRef} role="img" aria-label="Authenticator setup QR code. Alternatively enter the setup key below." className="max-w-full h-auto rounded-lg bg-white" />
                      </div>
                    ) : <p role="status" className="text-sm text-muted-foreground">The QR code is unavailable. Use the setup key below instead.</p>}
                    <p className="text-xs leading-5 text-muted-foreground">Cannot scan? Add a time-based account manually using this setup key. Keep it private.</p>
                    <label htmlFor="mfa-manual-secret" className="block text-xs font-semibold">Manual setup key</label>
                    <input id="mfa-manual-secret" type="text" readOnly value={enrollData.manualSecret} autoComplete="off" spellCheck={false} className="focus-ring w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm" onFocus={e => e.target.select()} />
                  </div>
                  <label htmlFor="mfa-enroll-code" className="block text-sm font-semibold">2. Enter the 6-digit authenticator code</label>
                  <input id="mfa-enroll-code" type="text" inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} value={enrollCode} onChange={e => setEnrollCode(e.target.value.replace(/\D/g, "").slice(0, 6))} className="focus-ring w-full h-12 px-3 rounded-xl border border-border bg-background text-center font-mono text-2xl tracking-widest" aria-describedby="mfa-enroll-help" />
                  <p id="mfa-enroll-help" className="text-xs leading-5 text-muted-foreground">Use the current code shown in your authenticator app.</p>
                </>
              )}
              {error && <div role="alert" aria-live="assertive" className="rounded-xl border border-rose-500/30 bg-rose-500/15 p-3 text-sm text-rose-700 dark:text-rose-300">{error}</div>}
              {!enrollData && !enrollLoading && error && <button type="button" onClick={() => { enrollRequested.current = false; void loadEnrollment(); }} className="focus-ring touch-target w-full rounded-xl border border-border px-4 py-3 text-sm font-semibold">Retry authenticator setup</button>}
              <button type="submit" disabled={busy || enrollLoading || !enrollData || enrollCode.length !== 6} className="focus-ring touch-target w-full rounded-xl bg-[#376b9b] px-4 py-3 text-sm font-bold text-white hover:bg-[#2b567e] disabled:opacity-50">{busy ? "Verifying…" : "Verify and continue"}</button>
              <button type="button" disabled={busy} onClick={cancelSignIn} className="focus-ring touch-target w-full rounded-lg py-2 text-sm font-semibold text-muted-foreground underline underline-offset-4">Cancel and return to sign-in</button>
            </form>
          ) : stage === "recovery_codes" ? (
            <section className="space-y-4" aria-labelledby="recovery-codes-heading">
              <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider"><CheckCircle size={14} aria-hidden="true" /> Authenticator connected</div>
              <h2 id="recovery-codes-heading" ref={stageHeadingRef} tabIndex={-1} className="text-xl font-bold focus-ring rounded">Save your recovery codes</h2>
              <p className="text-sm leading-6 text-muted-foreground">These codes are shown only once. Store them in your password manager or another secure place before continuing. Each code can be used once if you lose access to your authenticator.</p>
              <ul aria-label="One-time recovery codes" className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-2 rounded-xl border border-border bg-muted/20 p-3">
                {(recoveryCodes || []).map(code => <li key={code} className="min-w-0 break-all rounded-lg bg-background px-2 py-2 text-center font-mono text-sm font-semibold select-all">{code}</li>)}
              </ul>
              <p className="text-xs leading-5 text-muted-foreground">Do not share these codes. Leaving or reloading this page will discard this one-time copy.</p>
              <button type="button" onClick={async () => {
                try {
                  if (!navigator.clipboard || !recoveryCodes?.length) throw new Error();
                  await navigator.clipboard.writeText(recoveryCodes.join("\n"));
                  setCopied(true); setError(null);
                } catch { setError("Could not copy automatically. Select the codes and save them manually before continuing."); }
              }} className="focus-ring touch-target w-full rounded-xl border border-border px-4 py-3 text-sm font-semibold inline-flex items-center justify-center gap-2">{copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}{copied ? "Recovery codes copied" : "Copy recovery codes"}</button>
              {copied && <p role="status" className="text-xs text-muted-foreground">Copied. Save them securely, then clear your clipboard when finished.</p>}
              {error && <div role="alert" aria-live="assertive" className="rounded-xl border border-rose-500/30 bg-rose-500/15 p-3 text-sm text-rose-700 dark:text-rose-300">{error}</div>}
              <button type="button" disabled={!recoveryCodes?.length} onClick={() => { setCopied(false); setError(null); finishMfaRecoveryCodes(); }} className="focus-ring touch-target w-full rounded-xl bg-[#376b9b] px-4 py-3 text-sm font-bold text-white hover:bg-[#2b567e] disabled:opacity-50">I have saved my recovery codes — continue</button>
              <button type="button" disabled={busy} onClick={cancelSignIn} className="focus-ring touch-target w-full rounded-lg py-2 text-sm font-semibold text-muted-foreground underline underline-offset-4">Cancel and return to sign-in</button>
            </section>
          ) : stage === "password_change" ? (
            <form onSubmit={onPasswordSubmit} className="space-y-4" aria-busy={busy}>
              <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider"><KeyRound size={14} aria-hidden="true" /> Final security step</div>
              <h2 ref={stageHeadingRef} tabIndex={-1} className="text-xl font-bold focus-ring rounded">Choose your new password</h2>
              <p className="text-sm leading-6 text-muted-foreground">Replace your initial password before accessing the portal. Your new password must be different from your current password.</p>
              <label htmlFor="initial-current-password" className="block text-sm font-semibold">Current or temporary password</label>
              <input id="initial-current-password" type="password" required autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} className="focus-ring w-full h-11 px-3 rounded-xl border border-border bg-background text-sm" />
              <label htmlFor="initial-new-password" className="block text-sm font-semibold">New password</label>
              <input id="initial-new-password" type="password" required minLength={14} maxLength={256} autoComplete="new-password" aria-describedby="initial-password-help" value={newPassword} onChange={e => setNewPassword(e.target.value)} className="focus-ring w-full h-11 px-3 rounded-xl border border-border bg-background text-sm" />
              <p id="initial-password-help" className="text-xs leading-5 text-muted-foreground">Use 14–256 characters. A long, unique passphrase works well; no specific mix of uppercase letters, numbers, or symbols is required. Avoid known compromised passwords.</p>
              <label htmlFor="initial-confirm-password" className="block text-sm font-semibold">Confirm new password</label>
              <input id="initial-confirm-password" type="password" required minLength={14} maxLength={256} autoComplete="new-password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} className="focus-ring w-full h-11 px-3 rounded-xl border border-border bg-background text-sm" />
              {error && <div role="alert" aria-live="assertive" className="rounded-xl border border-rose-500/30 bg-rose-500/15 p-3 text-sm text-rose-700 dark:text-rose-300">{error}</div>}
              <button type="submit" disabled={busy} className="focus-ring touch-target w-full rounded-xl bg-[#376b9b] px-4 py-3 text-sm font-bold text-white hover:bg-[#2b567e] disabled:opacity-50">{busy ? "Updating password…" : "Update password and enter portal"}</button>
              <button type="button" disabled={busy} onClick={cancelSignIn} className="focus-ring touch-target w-full rounded-lg py-2 text-sm font-semibold text-muted-foreground underline underline-offset-4">Cancel and return to sign-in</button>
            </form>
          ) : stage === "mfa_verify" ? (
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
              {error && <div role="alert" aria-live="assertive" className="p-3 rounded-xl bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30 text-xs flex items-center gap-2"><AlertCircle size={14} />{error}</div>}
              <button type="submit" disabled={busy} className="touch-target w-full py-2.5 font-bold rounded-xl bg-[#5A92C9] text-white hover:bg-[#4a80b3] disabled:opacity-50 focus-ring text-xs">
                {busy ? "Verifying…" : "Verify and sign in"}
              </button>
              <div className="text-center text-xs">
                <button type="button" onClick={() => setUseRecovery(!useRecovery)} className="font-semibold text-[#5A92C9] hover:underline">
                  {useRecovery ? "Use authenticator code instead" : "Trouble signing in? Use recovery code"}
                </button>
              </div>
              <button type="button" disabled={busy} onClick={cancelSignIn} className="focus-ring touch-target w-full py-2 text-xs font-semibold text-muted-foreground underline">Cancel and return to sign-in</button>
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
                    value={setupConfirm}
                    onChange={e => setSetupConfirm(e.target.value)}
                    className="h-11 w-full rounded-xl border border-border bg-background pl-10 pr-3 text-sm focus-ring"
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">Use any password you prefer. A password generator is included below for convenience.</p>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <button type="button" onClick={() => { const pw = generateStrongPassword(); setSetupPassword(pw); setSetupConfirm(pw); setGeneratedInfo(pw); setShowSetupPass(true); setCopiedPass(false); }} className="font-semibold text-[#5A92C9] hover:underline flex items-center gap-1">
                    <Sparkles size={12} /> Generate strong password
                  </button>
                  {generatedInfo && (
                    <button type="button" onClick={() => { navigator.clipboard?.writeText(generatedInfo); setCopiedPass(true); }} className="text-muted-foreground hover:underline flex items-center gap-1">
                      {copiedPass ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                      {copiedPass ? "Copied" : "Copy"}
                    </button>
                  )}
                </div>

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
                <div className="flex items-center justify-end text-xs text-muted-foreground">
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
