import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { LimitModel, TokenPriceModel } from "@/models";
import {
  ApiError,
  CreateLimitSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  LimitEntityTypeSchema,
  LimitTypeSchema,
  SelectLimitSchema,
  UpdateLimitSchema,
  UuidIdSchema,
} from "@/types";

const limitsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/limits",
    {
      schema: {
        operationId: RouteId.GetLimits,
        description: "Get all limits with optional filtering",
        tags: ["Limits"],
        querystring: z.object({
          entityType: LimitEntityTypeSchema.optional(),
          entityId: z.string().optional(),
          limitType: LimitTypeSchema.optional(),
        }),
        response: constructResponseSchema(z.array(SelectLimitSchema)),
      },
    },
    async (
      { query: { entityType, entityId, limitType }, organizationId },
      reply,
    ) => {
      // Cleanup limits if needed before fetching
      if (organizationId) {
        await LimitModel.cleanupLimitsIfNeeded(organizationId);
      }

      // Ensure all models from interactions have pricing records
      await TokenPriceModel.ensureAllModelsHavePricing();

      const limits = await LimitModel.findAll(entityType, entityId, limitType);
      return reply.send(limits);
    },
  );

  fastify.post(
    "/api/limits",
    {
      schema: {
        operationId: RouteId.CreateLimit,
        description: "Create a new limit",
        tags: ["Limits"],
        body: CreateLimitSchema,
        response: constructResponseSchema(SelectLimitSchema),
      },
    },
    async ({ body }, reply) => {
      return reply.send(await LimitModel.create(body));
    },
  );

  fastify.get(
    "/api/limits/:id",
    {
      schema: {
        operationId: RouteId.GetLimit,
        description: "Get a limit by ID",
        tags: ["Limits"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectLimitSchema),
      },
    },
    async ({ params: { id } }, reply) => {
      const limit = await LimitModel.findById(id);

      if (!limit) {
        throw new ApiError(404, "Limit not found");
      }

      return reply.send(limit);
    },
  );

  fastify.patch(
    "/api/limits/:id",
    {
      schema: {
        operationId: RouteId.UpdateLimit,
        description: "Update a limit",
        tags: ["Limits"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdateLimitSchema.partial(),
        response: constructResponseSchema(SelectLimitSchema),
      },
    },
    async ({ params: { id }, body }, reply) => {
      const limit = await LimitModel.patch(id, body);

      if (!limit) {
        throw new ApiError(404, "Limit not found");
      }

      return reply.send(limit);
    },
  );

  fastify.delete(
    "/api/limits/:id",
    {
      schema: {
        operationId: RouteId.DeleteLimit,
        description: "Delete a limit",
        tags: ["Limits"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id } }, reply) => {
      const deleted = await LimitModel.delete(id);

      if (!deleted) {
        throw new ApiError(404, "Limit not found");
      }

      return reply.send({ success: true });
    },
  );
};

export default limitsRoutes;
