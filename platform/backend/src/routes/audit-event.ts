import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AuditEventModel } from "@/models";
import { constructResponseSchema, SelectAuditEventSchema } from "@/types";

const auditEventRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/audit-events",
    {
      schema: {
        operationId: RouteId.GetAuditEvents,
        description: "Get audit events for the organization",
        tags: ["Audit"],
        querystring: PaginationQuerySchema.extend({
          actorUserId: z.string().optional(),
          action: z.string().optional(),
          resourceType: z.string().optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
          search: z.string().optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectAuditEventSchema),
        ),
      },
    },
    async ({ organizationId, query }, reply) => {
      const {
        limit,
        offset,
        actorUserId,
        action,
        resourceType,
        from,
        to,
        search,
      } = query;

      const result = await AuditEventModel.getAllPaginated({
        organizationId,
        limit,
        offset,
        actorUserId,
        action,
        resourceType,
        from,
        to,
        search,
      });

      return reply.send({
        data: result.data,
        pagination: calculatePaginationMeta(result.total, { limit, offset }),
      });
    },
  );
};

export default auditEventRoutes;
