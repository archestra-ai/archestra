import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { AuditLogModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  createSortingQuerySchema,
  SelectAuditLogSchema,
  UuidIdSchema,
} from "@/types";

const auditLogRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/audit-logs",
    {
      schema: {
        operationId: RouteId.GetAuditLogs,
        description:
          "Get paginated audit log entries for the organization. Admin users see all entries; non-admin users see only their own.",
        tags: ["Audit Log"],
        querystring: z
          .object({
            action: z.string().optional(),
            resource: z.string().optional(),
            userId: UuidIdSchema.optional(),
            startDate: z.string().datetime().optional(),
            endDate: z.string().datetime().optional(),
            search: z.string().optional(),
          })
          .merge(PaginationQuerySchema)
          .merge(
            createSortingQuerySchema([
              "createdAt",
              "action",
              "resource",
            ] as const),
          ),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectAuditLogSchema),
        ),
      },
    },
    async (
      {
        query: { action, resource, userId, startDate, endDate, search, limit, offset, sortBy, sortDirection },
        user,
        headers,
        organizationId,
      },
      reply,
    ) => {
      const pagination = { limit, offset };
      const sorting = { sortBy, sortDirection };
      const filters = {
        action: action || undefined,
        resource: resource || undefined,
        userId: userId || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        search: search || undefined,
      };

      const { success: isAdmin } = await hasPermission(
        { auditLog: ["read"] },
        headers,
      );

      return reply.send(
        await AuditLogModel.findAllPaginated(
          organizationId,
          pagination,
          sorting,
          user.id,
          isAdmin,
          filters,
        ),
      );
    },
  );

  fastify.get(
    "/api/audit-logs/:auditLogId",
    {
      schema: {
        operationId: RouteId.GetAuditLog,
        description: "Get a single audit log entry by ID",
        tags: ["Audit Log"],
        params: z.object({
          auditLogId: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectAuditLogSchema),
      },
    },
    async ({ params: { auditLogId }, user, headers, organizationId }, reply) => {
      const { success: isAdmin } = await hasPermission(
        { auditLog: ["read"] },
        headers,
      );

      const auditLog = await AuditLogModel.findById(
        auditLogId,
        organizationId,
        user.id,
        isAdmin,
      );

      if (!auditLog) {
        throw new ApiError(404, "Audit log entry not found");
      }

      return reply.send(auditLog);
    },
  );
};

export default auditLogRoutes;
