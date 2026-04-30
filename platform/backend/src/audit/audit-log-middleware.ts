import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { AuditEventModel } from "@/models";
import { diffAuditSnapshots, getAuditSnapshot } from "./audit-snapshots";

export const EXPLICIT_AUDIT_EVENT_LOGGED = Symbol("explicit_audit_event_logged");
const AUDIT_CONTEXT = Symbol("audit_context");

/**
 * Global audit logger for "everything audited":
 * records every mutating /api request (POST/PUT/PATCH/DELETE) that returns 2xx.
 *
 * High-fidelity per-route logs can still be emitted explicitly via AuditEventModel.create().
 */
const auditLogMiddlewarePlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/api/")) return;
    if (request.method === "GET" || request.method === "HEAD") return;
    if (request.method === "OPTIONS") return;
    if (request.url.startsWith("/api/audit-events")) return;
    if (request.url.startsWith("/api/auth/")) return;

    // Only attempt “friendly” context for routes that have a simple :id param.
    const params = request.params as Record<string, unknown> | undefined;
    const id = params && typeof params.id === "string" ? params.id : null;
    if (!id) return;

    const resourceType = inferResourceTypeFromUrl(request.url);
    if (!resourceType) return;

    const organizationId = request.organizationId;
    const before = await getAuditSnapshot({
      resourceType,
      resourceId: id,
      organizationId,
    });

    (request as unknown as Record<symbol, unknown>)[AUDIT_CONTEXT] = {
      resourceType,
      resourceId: id,
      before,
    };
  });

  fastify.addHook("onResponse", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (request.method === "GET" || request.method === "HEAD") return;
    if (request.method === "OPTIONS") return;

    // Avoid recursion / noise
    if (request.url.startsWith("/api/audit-events")) return;
    // Avoid logging auth endpoints (often contain secrets/tokens)
    if (request.url.startsWith("/api/auth/")) return;

    // Only log successful mutations
    if (reply.statusCode < 200 || reply.statusCode >= 300) return;

    // If a route already emitted a domain-specific audit event for this request,
    // skip the generic http.mutation to avoid noisy duplicates.
    if ((request as unknown as Record<symbol, unknown>)[EXPLICIT_AUDIT_EVENT_LOGGED]) {
      return;
    }

    const organizationId = request.organizationId;
    const actorUserId = request.user?.id;
    if (!organizationId || !actorUserId) return;

    const ctx = (request as unknown as Record<symbol, unknown>)[AUDIT_CONTEXT] as
      | {
          resourceType: string;
          resourceId: string;
          before: Awaited<ReturnType<typeof getAuditSnapshot>>;
        }
      | undefined;

    if (ctx) {
      const after = await getAuditSnapshot({
        resourceType: ctx.resourceType,
        resourceId: ctx.resourceId,
        organizationId,
      });

      const changes = diffAuditSnapshots({ before: ctx.before, after });
      const action = inferFriendlyAction({
        resourceType: ctx.resourceType,
        method: request.method,
      });

      await AuditEventModel.create({
        organizationId,
        actorUserId,
        action,
        resourceType: ctx.resourceType,
        resourceId: ctx.resourceId,
        ipAddress: request.ip,
        userAgent: truncateHeaderValue(request.headers["user-agent"]),
        metadata: {
          method: request.method,
          url: truncateString(request.url, 2048),
          statusCode: reply.statusCode,
          resourceName: after?.name ?? ctx.before?.name ?? null,
          before: ctx.before?.fields ?? null,
          after: after?.fields ?? null,
          changes,
        },
      });
      return;
    }

    // Fallback: keep metadata intentionally small and safe (no request body).
    await AuditEventModel.create({
      organizationId,
      actorUserId,
      action: "http.mutation",
      resourceType: "http",
      resourceId: null,
      ipAddress: request.ip,
      userAgent: truncateHeaderValue(request.headers["user-agent"]),
      metadata: {
        method: request.method,
        url: truncateString(request.url, 2048),
        statusCode: reply.statusCode,
      },
    });
  });
};

export const auditLogMiddleware = fp(auditLogMiddlewarePlugin);

function truncateHeaderValue(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return truncateString(value, 512);
}

function truncateString(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

function inferResourceTypeFromUrl(url: string): string | null {
  // Strip query string
  const path = url.split("?")[0] ?? url;

  if (path.startsWith("/api/teams/")) return "team";
  if (path.startsWith("/api/agents/")) return "agent";
  if (path.startsWith("/api/mcp_server/")) return "mcpServer";

  return null;
}

function inferFriendlyAction(params: {
  resourceType: string;
  method: string;
}): string {
  const verb =
    params.method === "DELETE"
      ? "delete"
      : params.method === "POST"
        ? "create"
        : "update";

  switch (params.resourceType) {
    case "team":
      return `team.${verb}`;
    case "agent":
      return `agent.${verb}`;
    case "mcpServer":
      return `mcpServer.${verb}`;
    default:
      return "http.mutation";
  }
}
