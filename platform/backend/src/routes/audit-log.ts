import { createPaginatedResponseSchema, PaginationQuerySchema, RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { AuditLogModel } from "@/models";
import { ApiError, constructResponseSchema } from "@/types";

const AuditLogEntrySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  actorEmail: z.string().nullable(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  resourceLabel: z.string().nullable(),
  action: z.string(),
  metadata: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.date(),
});

const AuditLogQuerySchema = PaginationQuerySchema.extend({
  actorId: z.string().optional().describe("Filter by actor user ID"),
  resourceType: z.string().optional().describe("Filter by resource type"),
  action: z.string().optional().describe("Filter by action"),
  from: z
    .string()
    .optional()
    .describe("ISO date string — return entries at or after this timestamp"),
  to: z
    .string()
    .optional()
    .describe("ISO date string — return entries at or before this timestamp"),
});

const auditLogRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/audit-logs",
    {
      schema: {
        operationId: RouteId.GetAuditLogs,
        description:
          "Get paginated audit log entries for the organization. Restricted to admins.",
        tags: ["Audit Log"],
        querystring: AuditLogQuerySchema,
        response: constructResponseSchema(
          createPaginatedResponseSchema(AuditLogEntrySchema),
        ),
      },
    },
    async (
      { query: { limit, offset, actorId, resourceType, action, from, to }, organizationId, headers },
      reply,
    ) => {
      const { success } = await hasPermission(
        { organizationSettings: ["read"] },
        headers,
      );
      if (!success) {
        throw new ApiError(403, "You do not have permission to view the audit log");
      }

      const result = await AuditLogModel.findPaginated(
        {
          organizationId,
          actorId,
          resourceType,
          action,
          from: from ? new Date(from) : undefined,
          to: to ? new Date(to) : undefined,
        },
        { limit, offset },
      );

      return reply.send(result);
    },
  );
};

export default auditLogRoutes;
