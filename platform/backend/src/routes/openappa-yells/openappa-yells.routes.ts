import {
  createCursorPaginatedResponseSchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import OpenAppaYellModel from "@/models/openappa-yell";
import { getOpenAppaYell, yellVisibility } from "@/services/openappa-yells";
import { ApiError, constructResponseSchema } from "@/types";
import {
  OpenAppaYellQuerySchema,
  OpenAppaYellSchema,
} from "@/types/openappa-yell";

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/api/openappa/yells",
    {
      schema: {
        operationId: RouteId.GetOpenAppaYells,
        tags: ["OpenAPPA"],
        querystring: OpenAppaYellQuerySchema,
        response: constructResponseSchema(
          createCursorPaginatedResponseSchema(OpenAppaYellSchema),
        ),
      },
    },
    async (request, reply) =>
      reply.send(
        await OpenAppaYellModel.list({
          ...request.query,
          ...(await yellVisibility({
            organizationId: request.organizationId,
            userId: request.user.id,
          })),
        }),
      ),
  );
  app.get(
    "/api/openappa/yells/summary",
    {
      schema: {
        operationId: RouteId.GetOpenAppaYellsSummary,
        tags: ["OpenAPPA"],
        response: constructResponseSchema(z.object({ unresolved: z.number() })),
      },
    },
    async (request, reply) =>
      reply.send(
        await OpenAppaYellModel.summary(
          await yellVisibility({
            organizationId: request.organizationId,
            userId: request.user.id,
          }),
        ),
      ),
  );
  app.get(
    "/api/openappa/yells/:id",
    {
      schema: {
        operationId: RouteId.GetOpenAppaYell,
        tags: ["OpenAPPA"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(OpenAppaYellSchema),
      },
    },
    async (request, reply) =>
      reply.send(
        await getOpenAppaYell({
          ...request.params,
          organizationId: request.organizationId,
          userId: request.user.id,
        }),
      ),
  );
  app.patch(
    "/api/openappa/yells/:id",
    {
      schema: {
        operationId: RouteId.UpdateOpenAppaYell,
        tags: ["OpenAPPA"],
        params: z.object({ id: z.uuid() }),
        body: z.object({ resolved: z.boolean() }),
        response: constructResponseSchema(OpenAppaYellSchema),
      },
    },
    async (request, reply) => {
      const scope = await yellVisibility({
        organizationId: request.organizationId,
        userId: request.user.id,
      });
      const before = await getOpenAppaYell({
        ...request.params,
        organizationId: request.organizationId,
        userId: request.user.id,
      });
      const row = await OpenAppaYellModel.setResolved({
        ...scope,
        id: before.id,
        userId: request.user.id,
        resolved: request.body.resolved,
      });
      if (!row) throw new ApiError(404, "Yell not found");
      request.auditBefore = {
        resolvedAt: before.resolvedAt,
        resolvedBy: before.resolvedBy,
      };
      request.auditAfter = {
        resolvedAt: row.resolvedAt,
        resolvedBy: row.resolvedBy,
      };
      return reply.send(row);
    },
  );
};
export default routes;
