import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { costExportService } from "@/services/cost-export";
import {
  CostExportRunResultSchema,
  CreateCostExportRequestSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  PublicCostExportSchema,
  UpdateCostExportRequestSchema,
  UuidIdSchema,
} from "@/types";

/** Scheduled exports of LLM cost and usage (FOCUS) to a blob provider. */
const costExportRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/cost-exports",
    {
      schema: {
        operationId: RouteId.ListCostExports,
        description: "List the organization's scheduled cost exports.",
        tags: ["Cost Exports"],
        response: constructResponseSchema(z.array(PublicCostExportSchema)),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(await costExportService.list(organizationId));
    },
  );

  fastify.post(
    "/api/cost-exports",
    {
      schema: {
        operationId: RouteId.CreateCostExport,
        description:
          "Schedule an export of LLM cost and usage to a blob provider. The first file covers the period in progress, once it completes.",
        tags: ["Cost Exports"],
        body: CreateCostExportRequestSchema,
        response: constructResponseSchema(PublicCostExportSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      return reply.send(
        await costExportService.create({ organizationId, data: body }),
      );
    },
  );

  fastify.put(
    "/api/cost-exports/:id",
    {
      schema: {
        operationId: RouteId.UpdateCostExport,
        description: "Update a scheduled cost export.",
        tags: ["Cost Exports"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateCostExportRequestSchema,
        response: constructResponseSchema(PublicCostExportSchema),
      },
    },
    async ({ organizationId, params, body }, reply) => {
      return reply.send(
        await costExportService.update({
          id: params.id,
          organizationId,
          data: body,
        }),
      );
    },
  );

  fastify.delete(
    "/api/cost-exports/:id",
    {
      schema: {
        operationId: RouteId.DeleteCostExport,
        description:
          "Delete a scheduled cost export. Files already written stay in the bucket.",
        tags: ["Cost Exports"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ organizationId, params }, reply) => {
      await costExportService.delete({ id: params.id, organizationId });
      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/cost-exports/:id/run",
    {
      schema: {
        operationId: RouteId.RunCostExport,
        description:
          "Run a cost export now: write every completed period not exported yet, or rewrite the most recent completed period when none is due.",
        tags: ["Cost Exports"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(CostExportRunResultSchema),
      },
    },
    async ({ organizationId, params }, reply) => {
      return reply.send(
        await costExportService.runNow({ id: params.id, organizationId }),
      );
    },
  );
};

export default costExportRoutes;
