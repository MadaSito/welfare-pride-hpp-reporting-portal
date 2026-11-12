import React, { useState, useEffect, useRef } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useBranding } from "../contexts/BrandingContext";
import { Mail, KeyRound, Shield, AlertCircle, CheckCircle, Copy, Check, Eye, EyeOff, Building2 } from "lucide-react";
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
  const { brand } = useBranding();
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
        headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
        body: JSON.stringify({ token: linkToken }),
      });
      if (!res.ok) throw new Error();
      pendingMagicLinkToken = null;
      setLinkToken(null);
      window.history.replaceState(window.history.state, "", "/");
      await refresh();
      // refresh() catches errors internally; offer a safe next step only on the anonymous screen.
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
          <img src={iconUrl} alt="" className="mx-auto h-14 w-14 rounded-full object-cover shadow-lg shadow-[#5A92C9]/20" />
          <h1 className="text-2xl font-bold tracking-tight">{companyName}</h1>
          <p className="text-sm font-medium text-muted-foreground">{tagline}</p>
        </div>

        {/* Card */}
        <div className="rounded-2xl bg-card border border-border p-6 sm:p-7 panel-shadow space-y-5">
          {stage === "password_change" ? (
            <form onSubmit={onPasswordSubmit} className="space-y-4 text-xs">
              <h2 className="text-base font-bold">Change your temporary password</h2>
              <p className="text-muted-foreground">MFA is verified. Choose a new password before accessing the portal: 14–128 characters, upper and lowercase letters, at least two digits and three symbols.</p>
              {enrollCodesIssued && <div className="rounded-xl border border-border bg-muted/40 p-4 space-y-2"><strong>Save your eight one-time MFA recovery codes now; they cannot be shown again.</strong><div className="grid grid-cols-2 gap-1 font-mono select-all">{enrollCodesIssued.map(c => <span key={c}>{c}</span>)}</div></div>}
              <label className="block font-semibold">Temporary password<input required type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} className="mt-1 w-full h-11 px-3 rounded-xl border border-border bg-background" /></label>
              <label className="block font-semibold">New password<input required type="password" autoComplete="new-password" minLength={14} maxLength={128} value={newPassword} onChange={e => setNewPassword(e.target.value)} className="mt-1 w-full h-11 px-3 rounded-xl border border-border bg-background" /></label>
              <label className="block font-semibold">Confirm new password<input required type="password" autoComplete="new-password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} className="mt-1 w-full h-11 px-3 rounded-xl border border-border bg-background" /></label>
              {error && <div role="alert" className="text-rose-600">{error}</div>}
              <button disabled={busy} className="w-full py-2.5 font-bold rounded-xl bg-[#5A92C9] text-white disabled:opacity-50">{busy ? "Changing…" : "Change password and continue"}</button>
              <button type="button" onClick={() => logout()} className="w-full text-muted-foreground underline">Sign out</button>
            </form>
          ) : stage === "recovery_codes" ? (
            <div className="space-y-4 text-xs"><h2 className="text-base font-bold">Save your MFA recovery codes</h2><p>Store these one-time codes securely. They will not be shown again.</p><div className="grid grid-cols-2 gap-1 font-mono select-all">{enrollCodesIssued?.map(c => <span key={c}>{c}</span>)}</div><button onClick={() => refresh()} className="w-full py-2.5 font-bold rounded-xl bg-[#5A92C9] text-white">Continue</button></div>
          ) : stage === "mfa_enroll" ? (
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
                  <Mail size={18} aria-hidden="true" className="absolute left-3 top-3.5 text-muted-foreground" />
                  <input id="login-email" type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@organization.org" className="focus-ring h-12 w-full rounded-xl border border-border bg-background pl-10 pr-3 text-sm" />
                </div>
                <label className="block text-sm font-semibold" htmlFor="login-password">Password</label>
                <div className="relative">
                  <KeyRound size={18} aria-hidden="true" className="absolute left-3 top-3.5 text-muted-foreground" />
                  <input id="login-password" type={showPass ? "text" : "password"} autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} className="focus-ring h-12 w-full rounded-xl border border-border bg-background pl-10 pr-12 text-sm" />
                  <button type="button" onClick={() => setShowPass(!showPass)} aria-label={showPass ? "Hide password" : "Show password"} aria-pressed={showPass} className="focus-ring absolute right-1 top-1 flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground">{showPass ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}</button>
                </div>
                <button type="submit" disabled={busy} className="focus-ring touch-target w-full rounded-xl bg-[#376b9b] px-4 py-3 text-sm font-bold text-white hover:bg-[#29597f] disabled:opacity-60">
                  {busy ? "Please wait…" : "Sign in with password"}
                </button>
              </form>
              {error && <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/15 p-3 text-sm text-rose-700 dark:text-rose-300">{error}</div>}
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
