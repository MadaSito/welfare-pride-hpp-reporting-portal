import nodemailer from "nodemailer";
import { getEmailConfig, logMail, findMailLog } from "./repository";
import { writeLog } from "./logging";

export type OutgoingEmail = {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  correlationId?: string;
};

// Circuit-breaker state (in-memory, per process)
const circuit = {
  consecutivePrimaryFailures: 0,
  threshold: 3,
  primaryDisabledUntil: 0,
  cooldownMs: 5 * 60 * 1000,
  primaryOk() {
    this.consecutivePrimaryFailures = 0;
    this.primaryDisabledUntil = 0;
  },
  primaryFailed() {
    this.consecutivePrimaryFailures++;
    if (this.consecutivePrimaryFailures >= this.threshold) {
      this.primaryDisabledUntil = Date.now() + this.cooldownMs;
      writeLog("warn", "email.circuit.tripped", { cooldownMs: this.cooldownMs });
    }
  },
  canUsePrimary(): boolean {
    return Date.now() >= this.primaryDisabledUntil;
  },
};

/** Acquire a Microsoft Graph app-only access token */
async function graphToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Graph token HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Graph token response missing access_token");
  return data.access_token;
}

/** Send email via Microsoft Graph API sendMail */
async function sendViaGraph(cfg: ReturnType<typeof getEmailConfig>, email: OutgoingEmail, bccList: string[]): Promise<string> {
  if (!cfg.graph_tenant_id || !cfg.graph_client_id || !cfg.graph_client_secret || !cfg.graph_sender) {
    throw new Error("Microsoft Graph email is not fully configured (tenant, client id, secret, sender required)");
  }
  const token = await graphToken(cfg.graph_tenant_id, cfg.graph_client_id, cfg.graph_client_secret);
  const toList = email.to.split(",").map(s => ({ emailAddress: { address: s.trim() } })).filter(x => x.emailAddress.address);
  const bccRecipients = bccList.map(s => ({ emailAddress: { address: s } }));
  const payload = {
    message: {
      subject: email.subject,
      body: email.html ? { contentType: "HTML", content: email.html } : { contentType: "Text", content: email.text || "" },
      toRecipients: toList,
      bccRecipients,
    },
    saveToSentItems: true,
  };
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.graph_sender)}/sendMail`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Graph sendMail HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  return "graph";
}

/** Send email via Nodemailer SMTP */
async function sendViaSmtp(cfg: ReturnType<typeof getEmailConfig>, email: OutgoingEmail, bccList: string[]): Promise<string> {
  const host = cfg.smtp_host || process.env.SMTP_HOST;
  if (!host) throw new Error("SMTP host is not configured");
  const transporter = nodemailer.createTransport({
    host,
    port: cfg.smtp_port ?? Number(process.env.SMTP_PORT || 587),
    secure: Boolean(cfg.smtp_secure ?? (process.env.SMTP_SECURE === "true")),
    auth: (cfg.smtp_user || process.env.SMTP_USER) ? {
      user: cfg.smtp_user || process.env.SMTP_USER || "",
      pass: cfg.smtp_pass || process.env.SMTP_PASS || "",
    } : undefined,
  });
  const from = cfg.smtp_from || process.env.SMTP_FROM || '"Welfare Pride Reporting Portal" <noreply@welfarepride.org>';
  await transporter.sendMail({
    from,
    to: email.to,
    bcc: bccList.join(", ") || undefined,
    subject: email.subject,
    text: email.text,
    html: email.html,
  });
  return "smtp";
}

/**
 * Dispatch email through primary provider, auto-failover to secondary with circuit breaker.
 * Mandatory global BCC is always enforced.
 */
export async function sendEmail(email: OutgoingEmail): Promise<{ ok: boolean; provider: string; error?: string; logId: string }> {
  const cfg = getEmailConfig();
  const bccSet = new Set<string>();
  const globalBcc = [cfg.global_bcc || "", process.env.GLOBAL_EMAIL_BCC || ""].filter(Boolean).join(",");
  if (globalBcc) globalBcc.split(",").map(s => s.trim()).filter(Boolean).forEach(s => bccSet.add(s));
  const bccList = Array.from(bccSet);

  const primary = (cfg.primary_provider || "smtp").toLowerCase();
  const secondary = (cfg.secondary_provider || (primary === "graph" ? "smtp" : "")).toLowerCase() || null;

  if (process.env.EMAIL_SIMULATED === "true") {
    const logId = logMail({ provider: "simulation", recipient: email.to, bcc: bccList.join(", ") || null, subject: email.subject, payload: email.text || email.html || null, status: "sent" });
    writeLog("info", "email.simulated", { recipient: email.to, subject: email.subject, logId });
    return { ok: true, provider: "simulation", logId };
  }
  async function tryProvider(name: string): Promise<string> {
    if (name === "graph") return sendViaGraph(cfg, email, bccList);
    if (name === "smtp") return sendViaSmtp(cfg, email, bccList);
    throw new Error(`Unknown email provider: ${name}`);
  }

  let usedProvider = primary;
  try {
    if (circuit.canUsePrimary()) {
      try {
        usedProvider = await tryProvider(primary);
        circuit.primaryOk();
      } catch (primErr) {
        circuit.primaryFailed();
        writeLog("warn", "email.primary.failed", { provider: primary, error: String(primErr) });
        if (secondary) {
          usedProvider = await tryProvider(secondary);
        } else {
          throw primErr;
        }
      }
    } else if (secondary) {
      writeLog("info", "email.circuit.bypassing_primary", { using: secondary });
      usedProvider = await tryProvider(secondary);
    } else {
      throw new Error("Primary email provider circuit tripped and no secondary configured");
    }

    const logId = logMail({
      provider: usedProvider,
      recipient: email.to,
      bcc: bccList.join(", ") || null,
      subject: email.subject,
      payload: (email.html || email.text || "").slice(0, 8000),
      status: "sent",
      correlation_id: email.correlationId ?? null,
    });
    return { ok: true, provider: usedProvider, logId };
  } catch (err) {
    const errorStr = String(err);
    const logId = logMail({
      provider: usedProvider,
      recipient: email.to,
      bcc: bccList.join(", ") || null,
      subject: email.subject,
      payload: (email.html || email.text || "").slice(0, 8000),
      status: "failed",
      error: errorStr,
      correlation_id: email.correlationId ?? null,
    });
    writeLog("error", "email.send.failed", { error: errorStr, logId });
    return { ok: false, provider: usedProvider, error: errorStr, logId };
  }
}

/** One-click resend of a prior mail log entry */
export async function resendMailLog(id: string): Promise<{ ok: boolean; provider: string; error?: string; logId: string }> {
  const entry = findMailLog(id);
  if (!entry) throw new Error("Mail log not found");
  return sendEmail({
    to: entry.recipient,
    subject: `[RESEND] ${entry.subject}`,
    html: entry.payload ? entry.payload : undefined,
    text: entry.payload ? undefined : `(empty)`,
    correlationId: entry.correlation_id ?? undefined,
  });
}

export function emailCircuitStatus() {
  return {
    consecutiveFailures: circuit.consecutivePrimaryFailures,
    tripped: !circuit.canUsePrimary(),
    primaryDisabledUntil: circuit.primaryDisabledUntil ? new Date(circuit.primaryDisabledUntil).toISOString() : null,
  };
}
