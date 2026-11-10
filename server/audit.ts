import type { Role } from "./security";
import { insertAuditEvent, type AuditEventRow } from "./repository";
import { writeLog } from "./logging";
import { dispatchToSiem } from "./siem";

export type AuditEventInput = {
  requestId: string;
  actorId?: string | null;
  actorRole?: Role | null;
  actorEmail?: string | null;
  tenantId?: string | null;
  action: string;
  severity?: "info" | "warning" | "critical";
  resourceType: string;
  resourceId?: string | null;
  ipHash: string;
  realIp?: string | null;
  geoCountry?: string | null;
  userAgent?: string | null;
  method: string;
  statusCode: number;
  beforeState?: object | null;
  afterState?: object | null;
  metadata?: object;
};

export async function recordAudit(event: AuditEventInput): Promise<string> {
  const id = insertAuditEvent(event);
  writeLog(event.severity === "critical" ? "error" : event.severity === "warning" ? "warn" : "info", "audit.event", {
    auditId: id,
    requestId: event.requestId,
    action: event.action,
    actorId: event.actorId,
    actorRole: event.actorRole,
    tenantId: event.tenantId,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    statusCode: event.statusCode,
    severity: event.severity ?? "info",
    geoCountry: event.geoCountry,
  });
  // Asynchronous SIEM forwarding — failure is buffered, never breaks the request
  dispatchToSiem(event).catch(() => {});
  return id;
}

export type { AuditEventRow };
