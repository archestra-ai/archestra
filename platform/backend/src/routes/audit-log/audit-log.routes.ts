import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import { AuditLogModel } from "@/models";
import {
  ApiError,
  AuditActorTypeSchema,
  AuditEventNameSchema,
  AuditLogWithImpersonatorSchema,
  AuditOutcomeSchema,
  constructResponseSchema,
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
            resourceId: z
              .string()
              .optional()
              .describe("Filter by resource ID (e.g. a specific agent's ID)"),
            search: z
              .string()
              .optional()
              .describe(
                "Case-insensitive search across actor email, actor name, HTTP path, resource ID, and resource name",
              ),
          })
          .extend({
            sortDirection: SortDirectionSchema.optional().default("desc"),
          })
          .merge(PaginationQuerySchema),
        response: constructResponseSchema(
          createPaginatedResponseSchema(AuditLogWithImpersonatorSchema),
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
          resourceId,
          search,
          limit,
          offset,
          sortDirection,
        },
        user,
        organizationId,
      },
      reply,
    ) => {
      // auditLog:read scopes the view to the caller's own actions;
      // auditLog:admin lifts it to the whole organization.
      const canSeeAllAuditLogs = await userHasPermission(
        user.id,
        organizationId,
        "auditLog",
        "admin",
      );

      const result = await AuditLogModel.findPaginated({
        organizationId,
        limit,
        offset,
        sortDirection,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        actorId: canSeeAllAuditLogs ? actorId : user.id,
        action,
        outcome,
        actorType,
        resourceType,
        resourceId,
        search,
      });

      return reply.send(result);
    },
  );

  fastify.get(
    "/api/audit-logs/:id",
    {
      schema: {
        operationId: RouteId.GetAuditLog,
        description:
          "Get a single audit log event by ID. Requires auditLog:read permission (Admin only by default).",
        tags: ["Audit Log"],
        params: z.object({
          id: z.string().uuid(),
        }),
        response: constructResponseSchema(AuditLogWithImpersonatorSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      const auditLog = await AuditLogModel.findById(id, organizationId);

      // Own-actions view: an event someone else caused does not exist for
      // this caller — 404, not 403, so existence is not disclosed.
      if (auditLog) {
        const canSeeAllAuditLogs = await userHasPermission(
          user.id,
          organizationId,
          "auditLog",
          "admin",
        );
        if (!canSeeAllAuditLogs && auditLog.actorId !== user.id) {
          throw new ApiError(404, "Audit log not found");
        }
      }

      if (!auditLog) {
        throw new ApiError(404, "Audit log event not found");
      }

      return reply.send(auditLog);
    },
  );
};

export default auditLogRoutes;
