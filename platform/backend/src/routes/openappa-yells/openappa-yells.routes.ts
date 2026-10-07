import {
  createCursorPaginatedResponseSchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import OpenAppaYellModel from "@/models/openappa-yell";
import {
  downloadOpenAppaYell,
  getOpenAppaYell,
  listOpenAppaYells,
  resolveOpenAppaYell,
} from "@/services/openappa-yells";
import { constructResponseSchema } from "@/types";
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
        await listOpenAppaYells({
          ...request.query,
          organizationId: request.organizationId,
          userId: request.user.id,
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
        await OpenAppaYellModel.summary({
          organizationId: request.organizationId,
        }),
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
  app.get(
    "/api/openappa/yells/:id/archive",
    {
      schema: {
        operationId: RouteId.DownloadOpenAppaYell,
        tags: ["OpenAPPA"],
        params: z.object({ id: z.uuid() }),
        // Raw gzip bytes; the global error handler supplies JSON error responses.
      },
    },
    async (request, reply) => {
      const archive = await downloadOpenAppaYell({
        ...request.params,
        organizationId: request.organizationId,
        userId: request.user.id,
      });
      return reply
        .type("application/gzip")
        .header(
          "Content-Disposition",
          `attachment; filename="openappa-yell-${request.params.id}.json.gz"`,
        )
        .header("Cache-Control", "private, no-store")
        .send(archive);
    },
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
      const before = await getOpenAppaYell({
        ...request.params,
        organizationId: request.organizationId,
        userId: request.user.id,
      });
      const row = await resolveOpenAppaYell({
        organizationId: request.organizationId,
        id: before.id,
        userId: request.user.id,
        resolved: request.body.resolved,
      });
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
