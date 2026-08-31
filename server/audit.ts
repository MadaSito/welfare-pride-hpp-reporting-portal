import type { Role } from "./security";
import { getPool } from "./repository";
import { writeLog } from "./logging";

export type AuditEvent = { requestId: string; actorId?: string | null; tenantId?: string | null; action: string; severity?: "info" | "warning" | "critical"; resourceType: string; resourceId?: string | null; ipHash: string; userAgent?: string; method: string; statusCode: number; beforeState?: object | null; afterState?: object | null; metadata?: object; actorRole?: Role };

export async function recordAudit(event: AuditEvent) {
  const client = getPool();
  if (client) await client.query(`INSERT INTO audit_events (request_id, actor_id, tenant_id, action, severity, resource_type, resource_id, ip_hash, user_agent, method, status_code, before_state, after_state, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [event.requestId, event.actorId ?? null, event.tenantId ?? null, event.action, event.severity ?? "info", event.resourceType, event.resourceId ?? null, event.ipHash, event.userAgent?.slice(0, 512) ?? null, event.method, event.statusCode, event.beforeState ?? null, event.afterState ?? null, event.metadata ?? {}]);
  writeLog(event.severity === "critical" ? "error" : event.severity === "warning" ? "warn" : "info", "audit.event", { requestId: event.requestId, action: event.action, actorId: event.actorId, tenantId: event.tenantId, resourceType: event.resourceType, resourceId: event.resourceId, statusCode: event.statusCode, actorRole: event.actorRole });
}
