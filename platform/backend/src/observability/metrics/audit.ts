/**
 * Prometheus metrics for the audit log write path.
 *
 * Audit rows are written best-effort (fire-and-forget on the HTTP hook, and
 * `void`-dispatched on the auth surface), so a failed insert is otherwise only
 * a log line. This counter makes that loss alertable.
 *
 * Failed writes in the last 5m, by source:
 * sum by (source) (rate(audit_write_failures_total[5m]))
 */

import client from "prom-client";
import logger from "@/logging";

let auditWriteFailuresTotal: client.Counter<string>;

let initialized = false;

export function initializeAuditMetrics(): void {
  if (initialized) return;
  initialized = true;

  auditWriteFailuresTotal = new client.Counter({
    name: "audit_write_failures_total",
    help: "Total audit log rows that failed to persist, by source and resource type",
    labelNames: ["source", "resource_type"],
  });

  logger.info("Audit metrics initialized");
}

export function reportAuditWriteFailure(params: {
  source: "http" | "auth" | "mcp_tool";
  resourceType: string | null;
}): void {
  if (!auditWriteFailuresTotal) return;
  auditWriteFailuresTotal.inc({
    source: params.source,
    resource_type: params.resourceType ?? "unknown",
  });
}
