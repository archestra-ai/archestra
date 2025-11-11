import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { LimitModel, TokenPriceModel } from "@/models";
import {
  CreateLimitSchema,
  constructResponseSchema,
  LimitEntityTypeSchema,
  LimitTypeSchema,
  SelectLimitSchema,
  UpdateLimitSchema,
  UuidIdSchema,
} from "@/types";
import { cleanupLimitsIfNeeded } from "@/utils/limits-cleanup";

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
      try {
        // Cleanup limits if needed before fetching
        if (organizationId) {
          await cleanupLimitsIfNeeded(organizationId);
        }

        // Ensure all models from interactions have pricing records
        await TokenPriceModel.ensureAllModelsHavePricing();

        const limits = await LimitModel.findAll(
          entityType,
          entityId,
          limitType,
        );
        return reply.send(limits);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
    async (request, reply) => {
      try {
        return reply.send(await LimitModel.create(request.body));
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
    async (request, reply) => {
      try {
        const limit = await LimitModel.findById(request.params.id);

        if (!limit) {
          return reply.status(404).send({
            error: {
              message: "Limit not found",
              type: "not_found",
            },
          });
        }

        return reply.send(limit);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
      try {
        const limit = await LimitModel.patch(id, body);

        if (!limit) {
          return reply.status(404).send({
            error: {
              message: "Limit not found",
              type: "not_found",
            },
          });
        }

        return reply.send(limit);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request, reply) => {
      try {
        const deleted = await LimitModel.delete(request.params.id);

        if (!deleted) {
          return reply.status(404).send({
            error: {
              message: "Limit not found",
              type: "not_found",
            },
          });
        }

        return reply.send({ success: true });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );
};

export default limitsRoutes;
