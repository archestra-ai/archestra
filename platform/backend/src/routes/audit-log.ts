import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AuditLogModel } from "@/models";
import {
  AuditActorTypeSchema,
  AuditEventNameSchema,
  AuditOutcomeSchema,
  constructResponseSchema,
  SelectAuditLogSchema,
  SortDirectionSchema,
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
            actorId: z.string().optional().describe("Filter by actor ID"),
            action: AuditEventNameSchema.optional().describe(
              "Filter by action type (dotted name, e.g. agent.created)",
            ),
            outcome: AuditOutcomeSchema.optional().describe(
              "Filter by outcome (success, failure, or denied)",
            ),
            actorType: AuditActorTypeSchema.optional().describe(
              "Filter by actor type (user, api_key, sso, or system)",
            ),
            resourceType: z
              .string()
              .optional()
              .describe("Filter by resource type (e.g. agent, role)"),
            search: z
              .string()
              .optional()
              .describe(
                "Case-insensitive search across actor email, actor name, HTTP path, and resource ID",
              ),
          })
          .extend({
            sortDirection: SortDirectionSchema.optional().default("desc"),
          })
          .merge(PaginationQuerySchema),
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
          actorId,
          action,
          outcome,
          actorType,
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
        actorId,
        action,
        outcome,
        actorType,
        resourceType,
        search,
      });

      return reply.send(result);
    },
  );
};

export default auditLogRoutes;
