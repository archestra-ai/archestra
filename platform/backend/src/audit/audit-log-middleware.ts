import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { AuditEventModel } from "@/models";

/**
 * Global audit logger for "everything audited":
 * records every mutating /api request (POST/PUT/PATCH/DELETE) that returns 2xx.
 *
 * High-fidelity per-route logs can still be emitted explicitly via AuditEventModel.create().
 */
const auditLogMiddlewarePlugin: FastifyPluginAsync = async (fastify) => {
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

    const organizationId = request.organizationId;
    const actorUserId = request.user?.id;
    if (!organizationId || !actorUserId) return;

    // Keep metadata intentionally small and safe: do not include request body.
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
