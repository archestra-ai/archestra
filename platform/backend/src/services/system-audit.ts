import logger from "@/logging";
import { sanitizeAuditSnapshot } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import { reportAuditWriteFailure } from "@/observability/metrics/audit";
import type { AuditEventName } from "@/types/audit-log";

/**
 * Write an org-audit row for a background/system mutation of an audited
 * resource — scheduled GitHub skill sync rewriting content, ChatOps
 * auto-provisioning a member, a chat interaction binding an agent to a
 * channel. These paths bypass the HTTP audit hook, so without an explicit row
 * the resource changes with no provenance.
 *
 * Call sites `void` this (or await it off the hot path): failures log and
 * count via the audit-write-failure metric, never throw.
 */
export async function recordSystemAudit(params: {
  organizationId: string;
  action: AuditEventName;
  resourceType: string;
  resourceId: string | null;
  /** What performed the mutation (e.g. "GitHub skill sync"); shown as the actor. */
  actorName: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  occurredAt?: Date;
}): Promise<void> {
  try {
    await AuditLogModel.create({
      organizationId: params.organizationId,
      actorId: null,
      actorType: "system",
      actorName: params.actorName,
      actorEmail: null,
      action: params.action,
      outcome: "success",
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      before: sanitizeAuditSnapshot(params.before ?? null),
      after: sanitizeAuditSnapshot(params.after ?? null),
      httpMethod: null,
      httpPath: null,
      httpRoute: null,
      httpStatus: null,
      requestId: null,
      sourceIp: null,
      userAgent: null,
      occurredAt: params.occurredAt ?? new Date(),
    });
  } catch (err) {
    logger.error(
      { err, action: params.action, resourceType: params.resourceType },
      "audit: failed to write system audit row",
    );
    reportAuditWriteFailure({
      source: "system",
      resourceType: params.resourceType,
    });
  }
}
