import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AuditLogModel } from "@/models";
import {
  AuditActionSchema,
  constructResponseSchema,
  createSortingQuerySchema,
  SelectAuditLogSchema,
} from "@/types";

const auditLogRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/audit-logs",
    {
      schema: {
        operationId: RouteId.GetAuditLogs,
        description:
          "Get paginated audit log events for the organization. Requires auditLog:read permission (Admin only by default).",
        tags: ["Audit Log"],
        querystring: z
          .object({
            startDate: z
              .string()
              .datetime()
              .optional()
              .describe("Filter events on or after this date (ISO 8601)"),
            endDate: z
              .string()
              .datetime()
              .optional()
              .describe("Filter events on or before this date (ISO 8601)"),
            actorUserId: z
              .string()
              .optional()
              .describe("Filter by actor user ID"),
            action: AuditActionSchema.optional().describe(
              "Filter by action type",
            ),
            resourceType: z
              .string()
              .optional()
              .describe("Filter by resource type (e.g. agent, auth, role)"),
            search: z
              .string()
              .optional()
              .describe(
                "Case-insensitive search across actor email, actor name, HTTP path, and resource ID",
              ),
          })
          .merge(PaginationQuerySchema)
          .merge(createSortingQuerySchema(["createdAt"] as const)),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectAuditLogSchema),
        ),
      },
    },
    async (
      {
        query: {
          startDate,
          endDate,
          actorUserId,
          action,
          resourceType,
          search,
          limit,
          offset,
          sortDirection,
        },
        organizationId,
      },
      reply,
    ) => {
      const result = await AuditLogModel.findPaginated({
        organizationId,
        limit,
        offset,
        sortDirection,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        actorUserId,
        action,
        resourceType,
        search,
      });

      return reply.send(result);
    },
  );
};

export default auditLogRoutes;
