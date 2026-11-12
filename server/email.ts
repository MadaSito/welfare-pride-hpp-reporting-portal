import nodemailer from "nodemailer";
import { getEmailConfig, logMail, findMailLog } from "./repository";
import { writeLog } from "./logging";

export type OutgoingEmail = {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  correlationId?: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
  requireNoBcc?: boolean;
  // Credential-bearing messages are never retained, resent or failed over.
  sensitive?: boolean;
};

type EmailResult = { ok: boolean; provider: string; status: "sent" | "failed" | "simulated" | "unknown"; error?: string; logId: string };
const ATTACHMENT_LOG_SUBJECT = "[Attachment email: content not retained]";
const DISABLED_LOG_SUBJECT = "[Disabled email: content not retained]";
const SENSITIVE_LOG_SUBJECT = "[Sensitive email: content not retained]";
const REDACTED_PROVIDER_ERROR = "Email provider failed (details redacted)";
const ATTACHMENT_ACCEPTANCE_UNKNOWN = "The primary email provider did not confirm acceptance; acceptance may be unknown. No automatic failover was attempted. Verify with the recipient or provider before retrying.";
const ATTACHMENT_CIRCUIT_OPEN = "Email was not attempted because the primary provider circuit is open; no automatic failover was attempted.";

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
  // Provider responses may echo request data or secrets; do not retain them.
  if (!res.ok) throw new Error(`Graph token HTTP ${res.status}`);
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
      ...(email.attachments?.length ? { attachments: email.attachments.map(attachment => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: attachment.filename,
        contentType: attachment.contentType,
        contentBytes: attachment.content.toString("base64"),
      })) } : {}),
    },
    saveToSentItems: !email.sensitive,
  };
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.graph_sender)}/sendMail`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Graph sendMail HTTP ${res.status}`);
  return "graph";
}

/** Send email via Nodemailer SMTP */
async function sendViaSmtp(cfg: ReturnType<typeof getEmailConfig>, email: OutgoingEmail, bccList: string[]): Promise<string> {
  const host = cfg.smtp_host || process.env.SMTP_HOST;
  if (!host) throw new Error("SMTP host is not configured");
  const secure = Boolean(cfg.smtp_secure ?? (process.env.SMTP_SECURE === "true"));
  const hasAttachments = Boolean(email.attachments?.length);
  const transporter = nodemailer.createTransport({
    host,
    port: cfg.smtp_port ?? Number(process.env.SMTP_PORT || 587),
    secure,
    // secure=false selects STARTTLS, not an instruction to disable TLS.
    ...(hasAttachments || email.sensitive ? { requireTLS: !secure, disableFileAccess: true, disableUrlAccess: true } : {}),
    ...(email.sensitive ? { connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 } : {}),
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
    ...(hasAttachments ? { attachments: email.attachments!.map(({ filename, content, contentType }) => ({ filename, content, contentType })) } : {}),
  });
  return "smtp";
}

/**
 * Dispatch email through primary provider, with failover only for non-attachment emails.
 * Mandatory global BCC is enforced; requests that cannot allow it are rejected.
 */
export async function sendEmail(email: OutgoingEmail): Promise<EmailResult> {
  const cfg = getEmailConfig();
  // Only an explicit enabled value permits dispatch; missing or invalid values
  // fail closed as well. Check before simulation and all provider/failover paths.
  const enabled: unknown = cfg?.enabled;
  if (enabled !== 1 && enabled !== true) {
    const error = "Email engine is disabled";
    const logId = logMail({
      provider: "none",
      recipient: email.to,
      bcc: null,
      subject: DISABLED_LOG_SUBJECT,
      payload: null,
      status: "failed",
      error,
      correlation_id: email.correlationId ?? null,
    });
    writeLog("error", "email.send.failed", { error, logId });
    return { ok: false, provider: "none", status: "failed", error, logId };
  }
  const bccSet = new Set<string>();
  const globalBcc = [cfg.global_bcc || "", process.env.GLOBAL_EMAIL_BCC || ""].filter(Boolean).join(",");
  if (globalBcc) globalBcc.split(",").map(s => s.trim()).filter(Boolean).forEach(s => bccSet.add(s));
  const bccList = Array.from(bccSet);
  // Any supplied attachment field is treated as sensitive, including malformed inputs.
  const attachmentRequest = email.attachments !== undefined && (!Array.isArray(email.attachments) || email.attachments.length > 0);
  const nonretained = attachmentRequest || email.sensitive === true;
  const subject = email.sensitive ? SENSITIVE_LOG_SUBJECT : attachmentRequest ? ATTACHMENT_LOG_SUBJECT : email.subject;
  const payload = nonretained ? null : (email.html || email.text || "").slice(0, 8000);
  const primary = (cfg.primary_provider || "smtp").toLowerCase();
  const secondary = (cfg.secondary_provider || (primary === "graph" ? "smtp" : "")).toLowerCase() || null;

  function record(provider: string, status: EmailResult["status"], error?: string): string {
    return logMail({
      provider,
      recipient: email.to,
      bcc: bccList.join(", ") || null,
      subject,
      payload: status === "simulated" && !nonretained ? email.text || email.html || null : payload,
      status,
      error,
      correlation_id: email.correlationId ?? null,
    });
  }
  function reject(error: string): EmailResult {
    const logId = record("none", "failed", error);
    writeLog("error", "email.send.failed", { error, logId });
    return { ok: false, provider: "none", status: "failed", error, logId };
  }

  if ((email.requireNoBcc || email.sensitive) && (cfg.global_bcc?.trim() || process.env.GLOBAL_EMAIL_BCC?.trim())) {
    return reject("Email requires no BCC, but global BCC is configured");
  }
  if (email.attachments !== undefined && (!Array.isArray(email.attachments) || email.attachments.some(attachment =>
    !attachment || typeof attachment.filename !== "string" || !attachment.filename.trim() ||
    /[/\\\x00-\x1f\x7f]/.test(attachment.filename) || attachment.filename === "." || attachment.filename === ".." ||
    !Buffer.isBuffer(attachment.content) || typeof attachment.contentType !== "string" ||
    !attachment.contentType.trim() || /[\r\n]/.test(attachment.contentType)
  ))) {
    return reject("Invalid email attachment: expected a filename, Buffer content, and content type");
  }

  async function tryProvider(name: string): Promise<string> {
    if (name === "simulation") return "simulation";
    if (name === "graph") return sendViaGraph(cfg, email, bccList);
    if (name === "smtp") return sendViaSmtp(cfg, email, bccList);
    throw new Error(`Unknown email provider: ${name}`);
  }

  let usedProvider = process.env.EMAIL_SIMULATED === "true" ? "simulation" : primary;
  let attachmentPrimaryFailed = false;
  try {
    if (process.env.EMAIL_SIMULATED === "true") {
      // Never dispatch a provider in simulation mode.
    } else if (circuit.canUsePrimary()) {
      try {
        usedProvider = await tryProvider(primary);
        circuit.primaryOk();
      } catch (primErr) {
        circuit.primaryFailed();
        writeLog("warn", "email.primary.failed", { provider: primary, error: nonretained ? REDACTED_PROVIDER_ERROR : String(primErr) });
        if (nonretained) {
          // A provider error, especially a timeout, does not prove it rejected
          // the message. Never send the same attachment through another provider.
          attachmentPrimaryFailed = true;
          throw primErr;
        }
        if (secondary) {
          usedProvider = secondary;
          usedProvider = await tryProvider(secondary);
        } else {
          throw primErr;
        }
      }
    } else if (nonretained) {
      return reject(ATTACHMENT_CIRCUIT_OPEN);
    } else if (secondary) {
      writeLog("info", "email.circuit.bypassing_primary", { using: secondary });
      usedProvider = secondary;
      usedProvider = await tryProvider(secondary);
    } else {
      throw new Error("Primary email provider circuit tripped and no secondary configured");
    }

    const status = usedProvider === "simulation" ? "simulated" : "sent";
    const logId = record(usedProvider, status);
    if (status === "simulated") writeLog("info", "email.simulated", { recipient: email.to, subject, logId });
    return { ok: true, provider: usedProvider, status, logId };
  } catch (err) {
    const status = attachmentPrimaryFailed ? "unknown" : "failed";
    const errorStr = email.sensitive ? REDACTED_PROVIDER_ERROR : attachmentPrimaryFailed ? ATTACHMENT_ACCEPTANCE_UNKNOWN : attachmentRequest ? REDACTED_PROVIDER_ERROR : String(err);
    const logId = record(usedProvider, status, errorStr);
    writeLog("error", "email.send.failed", { error: errorStr, logId });
    return { ok: false, provider: usedProvider, status, error: errorStr, logId };
  }
}

/** One-click resend of a prior mail log entry */
export async function resendMailLog(id: string): Promise<EmailResult> {
  const entry = findMailLog(id);
  if (!entry) throw new Error("Mail log not found");
  if (entry.subject === ATTACHMENT_LOG_SUBJECT && !entry.payload) {
    throw new Error("Attachment emails cannot be resent from the mail log because their content is not retained");
  }
  if (entry.subject === DISABLED_LOG_SUBJECT && !entry.payload) {
    throw new Error("Disabled emails cannot be resent from the mail log because their content is not retained");
  }
  if (entry.subject === SENSITIVE_LOG_SUBJECT && !entry.payload) {
    throw new Error("Sensitive emails cannot be resent because their content is not retained");
  }
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
