import type { FastifyRequest } from "fastify";
import { AuditEventModel } from "@/models";
import { EXPLICIT_AUDIT_EVENT_LOGGED } from "./audit-log-middleware";

export async function emitAuditEvent(
  request: FastifyRequest,
  params: {
    action: string;
    resourceType: string;
    resourceId: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  const organizationId = request.organizationId;
  const actorUserId = request.user?.id ?? null;

  if (!organizationId) return;

  // Mark request as explicitly audited to avoid generic http.mutation duplicates.
  (request as unknown as Record<symbol, unknown>)[EXPLICIT_AUDIT_EVENT_LOGGED] =
    true;

  await AuditEventModel.create({
    organizationId,
    actorUserId,
    action: params.action,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"] ?? null,
    metadata: params.metadata ?? null,
  });
}

