import { type Logger, logs, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import {
  defaultResource,
  detectResources,
  envDetector,
  hostDetector,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import config from "@/config";
import type { AuditLog } from "@/types";

/**
 * Exports persisted audit metadata as OTLP logs. SDK batching is best-effort,
 * not an outbox.
 *
 * Records go through the backend's shared log pipeline, or, when
 * ARCHESTRA_AUDIT_LOG_OTEL_ENDPOINT is set, through a pipeline of their own,
 * so a security collector can receive them apart from general telemetry.
 */
class AuditLogExporter {
  private dedicatedProvider: LoggerProvider | null = null;

  export(row: AuditLog): void {
    if (!config.auditLog.otelEnabled) return;
    try {
      this.getLogger().emit({
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

  /** Flushes and closes the dedicated pipeline; the next export reopens it. */
  async shutdown(): Promise<void> {
    const provider = this.dedicatedProvider;
    this.dedicatedProvider = null;
    await provider?.shutdown();
  }

  private getLogger(): Logger {
    const exporter = config.auditLog.otelExporter;
    // Resolve lazily: the global provider must have been registered by SDK startup.
    if (!exporter) return logs.getLogger(AUDIT_SCOPE);
    this.dedicatedProvider ??= new LoggerProvider({
      // Service identity plus the host (the pod) and OTEL_RESOURCE_ATTRIBUTES,
      // so the collector can tell replicas apart.
      resource: defaultResource()
        .merge(detectResources({ detectors: [envDetector, hostDetector] }))
        .merge(
          resourceFromAttributes({
            [ATTR_SERVICE_NAME]: config.api.name,
            [ATTR_SERVICE_VERSION]: config.api.version,
          }),
        ),
      processors: [
        new BatchLogRecordProcessor({
          exporter: new OTLPLogExporter(exporter),
        }),
      ],
    });
    return this.dedicatedProvider.getLogger(AUDIT_SCOPE);
  }
}

export const auditLogExporter = new AuditLogExporter();

// === Internal helpers ===

const AUDIT_SCOPE = "archestra-audit";

/**
 * An explicit allowlist: snapshots and free text must never leak into export.
 * The actor's email and display name are the one exception, and only when the
 * operator opts in, so a SIEM can say who acted without a lookup by ID.
 */
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
    ...(config.auditLog.otelIncludeActorIdentity && {
      "archestra.audit.actor_email": row.actorEmail,
      "archestra.audit.actor_name": row.actorName,
    }),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== null && value !== undefined) attributes[key] = value;
  }
  return attributes;
}
