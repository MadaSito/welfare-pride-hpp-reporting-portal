import dgram from "node:dgram";
import os from "node:os";
import { enqueueSiemBuffer, getSiemConfig, listPendingSiemBuffer, markSiemBufferResult } from "./repository";
import { writeLog } from "./logging";

/** RFC 5424 Syslog priority computation */
function priority(facility: number, severity: string): number {
  const sevMap: Record<string, number> = { info: 6, warning: 4, critical: 2 };
  return (facility << 3) + (sevMap[severity] ?? 6);
}

/** RFC 5424 message builder */
function formatRfc5424(pri: number, hostname: string, app: string, msgId: string, payloadJson: string): string {
  const ts = new Date().toISOString();
  // <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA MSG
  return `<${pri}>1 ${ts} ${hostname} ${app} - ${msgId} - ${payloadJson}`;
}

/** Host allowlist check for SSRF protection */
function hostAllowed(host: string, allowedHostsCsv?: string | null): boolean {
  const envAllowed = process.env.SIEM_ALLOWED_HOSTS || "";
  const combined = [envAllowed, allowedHostsCsv || ""].filter(Boolean).join(",");
  if (!combined.trim()) return true; // no allowlist configured -> all allowed
  const list = combined.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(host.toLowerCase());
}

async function sendSyslog(host: string, port: number, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const buf = Buffer.from(message, "utf8");
    socket.send(buf, 0, buf.length, port, host, err => {
      try { socket.close(); } catch {}
      if (err) reject(err);
      else resolve();
    });
  });
}

async function sendWebhook(url: string, token: string | null, format: string, event: object): Promise<void> {
  const parsed = new URL(url);
  if (!hostAllowed(parsed.hostname)) throw new Error(`Destination host not allowed: ${parsed.hostname}`);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let body = JSON.stringify(event);

  if (format === "splunk") {
    if (token) headers["Authorization"] = `Splunk ${token}`;
    body = JSON.stringify({ event, sourcetype: "welfare-pride:hpp:audit" });
  } else if (format === "datadog") {
    if (token) headers["DD-API-KEY"] = token;
    headers["ddsource"] = "hpp-portal";
    headers["service"] = "welfare-pride-hpp";
  } else if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`SIEM webhook HTTP ${res.status}: ${await res.text().catch(() => "")}`);
}

export async function dispatchToSiem(event: {
  action: string;
  severity?: string;
  actorId?: string | null;
  actorRole?: string | null;
  actorEmail?: string | null;
  resourceType: string;
  resourceId?: string | null;
  realIp?: string | null;
  geoCountry?: string | null;
  requestId: string;
  method?: string;
  statusCode?: number;
  metadata?: object;
}): Promise<void> {
  const cfg = getSiemConfig();
  const tasks: Promise<unknown>[] = [];

  // Syslog RFC 5424
  if (cfg.syslog_enabled && cfg.syslog_host) {
    if (!hostAllowed(cfg.syslog_host, cfg.allowed_hosts)) {
      writeLog("warn", "siem.syslog.blocked", { host: cfg.syslog_host, reason: "allowlist" });
    } else {
      const pri = priority(cfg.syslog_facility ?? 16, event.severity ?? "info");
      const msg = formatRfc5424(pri, os.hostname(), "wp-hpp", event.action.replace(/\./g, "_"), JSON.stringify(event));
      tasks.push(
        sendSyslog(cfg.syslog_host, cfg.syslog_port ?? 514, msg).catch(err => {
          writeLog("error", "siem.syslog.error", { error: String(err) });
          enqueueSiemBuffer(JSON.stringify({ kind: "syslog", event }), String(err));
        }),
      );
    }
  }

  // Webhook
  if (cfg.webhook_enabled && cfg.webhook_url) {
    tasks.push(
      sendWebhook(cfg.webhook_url, cfg.webhook_token, cfg.webhook_format || "generic", event).catch(err => {
        writeLog("error", "siem.webhook.error", { error: String(err) });
        enqueueSiemBuffer(JSON.stringify({ kind: "webhook", event }), String(err));
      }),
    );
  }

  await Promise.allSettled(tasks);
}

/** Retry buffered events (called on an interval or manually) */
export async function flushSiemBuffer(): Promise<{ succeeded: number; failed: number }> {
  const items = listPendingSiemBuffer(30);
  const cfg = getSiemConfig();
  let succeeded = 0;
  let failed = 0;
  for (const item of items) {
    try {
      const parsed = JSON.parse(item.event_json);
      if (parsed.kind === "syslog" && cfg.syslog_enabled && cfg.syslog_host) {
        const pri = priority(cfg.syslog_facility ?? 16, parsed.event.severity ?? "info");
        const msg = formatRfc5424(pri, os.hostname(), "wp-hpp", (parsed.event.action || "audit").replace(/\./g, "_"), JSON.stringify(parsed.event));
        await sendSyslog(cfg.syslog_host, cfg.syslog_port ?? 514, msg);
      } else if (parsed.kind === "webhook" && cfg.webhook_enabled && cfg.webhook_url) {
        await sendWebhook(cfg.webhook_url, cfg.webhook_token, cfg.webhook_format || "generic", parsed.event);
      }
      markSiemBufferResult(item.id, true);
      succeeded++;
    } catch (err) {
      markSiemBufferResult(item.id, false, String(err), Math.min(900, 60 * Math.pow(2, item.attempts)));
      failed++;
    }
  }
  return { succeeded, failed };
}

export async function testSiem(dest: "syslog" | "webhook"): Promise<{ ok: boolean; message: string }> {
  const testEvent = {
    action: "siem.test",
    severity: "info",
    actorId: null,
    resourceType: "system",
    requestId: "test-" + Date.now(),
    realIp: "127.0.0.1",
    geoCountry: null,
    method: "POST",
    statusCode: 200,
    metadata: { note: "This is a connectivity test from Welfare Pride HPP Reporting Portal" },
  };
  const cfg = getSiemConfig();
  try {
    if (dest === "syslog") {
      if (!cfg.syslog_host) return { ok: false, message: "No syslog host configured" };
      if (!hostAllowed(cfg.syslog_host, cfg.allowed_hosts)) return { ok: false, message: "Host not in allowlist" };
      const pri = priority(cfg.syslog_facility ?? 16, "info");
      const msg = formatRfc5424(pri, os.hostname(), "wp-hpp", "siem_test", JSON.stringify(testEvent));
      await sendSyslog(cfg.syslog_host, cfg.syslog_port ?? 514, msg);
      return { ok: true, message: `Test message sent to syslog://${cfg.syslog_host}:${cfg.syslog_port ?? 514}` };
    }
    if (!cfg.webhook_url) return { ok: false, message: "No webhook URL configured" };
    await sendWebhook(cfg.webhook_url, cfg.webhook_token, cfg.webhook_format || "generic", testEvent);
    return { ok: true, message: `Test payload delivered to ${cfg.webhook_url}` };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}
