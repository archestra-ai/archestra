import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import config from "@/config";
import type { AuditLog } from "@/types";

/** Export only persisted audit metadata. SDK batching is best-effort, not an outbox. */
export function exportAuditLog(row: AuditLog): void {
  if (!config.auditLog.otelEnabled) return;
  try {
    // Resolve lazily: the global provider must have been registered by SDK startup.
    logs.getLogger("archestra-audit").emit({
      eventName: `archestra.audit.${row.action}`,
      body: row.action,
      timestamp: row.occurredAt,
      observedTimestamp: row.createdAt,
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      attributes: auditLogAttributes(row),
    });
  } catch {
    // Export cannot turn a successful database insert into a failed audit write.
  }
}

/** An explicit allowlist: snapshots and free text must never leak into export. */
function auditLogAttributes(row: AuditLog): Record<string, string | number> {
  const attributes: Record<string, string | number> = {
    "event.name": `archestra.audit.${row.action}`,
    "log.record.uid": row.id,
    // Product-specific audit fields have no matching OTel audit event schema.
    "archestra.audit.schema_version": 1,
    "archestra.audit.event_sequence": row.eventSequence,
    "archestra.organization.id": row.organizationId,
    "archestra.audit.action": row.action,
    "archestra.audit.outcome": row.outcome,
    "archestra.audit.actor_type": row.actorType,
  };
  const optional = {
    "archestra.audit.actor_id": row.actorId,
    "archestra.audit.impersonated_by": row.impersonatedBy,
    "archestra.audit.resource_type": row.resourceType,
    "archestra.audit.resource_id": row.resourceId,
    "archestra.audit.request_id": row.requestId,
    "http.request.method": row.httpMethod,
    "http.route": row.httpRoute,
    "http.response.status_code": row.httpStatus,
    "client.address": row.sourceIp,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== null && value !== undefined) attributes[key] = value;
  }
  return attributes;
}
