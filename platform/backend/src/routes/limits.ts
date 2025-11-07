import { RouteId } from "@shared";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import db, { schema } from "@/database";
import TokenPriceModel from "@/models/token-price";
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

        const conditions = [];

        if (entityType) {
          conditions.push(eq(schema.limitsTable.entityType, entityType));
        }

        if (entityId) {
          conditions.push(eq(schema.limitsTable.entityId, entityId));
        }

        if (limitType) {
          conditions.push(eq(schema.limitsTable.limitType, limitType));
        }

        const limits = await db
          .select()
          .from(schema.limitsTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined);
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
        const [limit] = await db
          .insert(schema.limitsTable)
          .values(request.body)
          .returning();

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
        const [limit] = await db
          .select()
          .from(schema.limitsTable)
          .where(eq(schema.limitsTable.id, request.params.id));

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

  fastify.put(
    "/api/limits/:id",
    {
      schema: {
        operationId: RouteId.UpdateLimit,
        description: "Update a limit",
        tags: ["Limits"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdateLimitSchema.omit({ id: true }),
        response: constructResponseSchema(SelectLimitSchema),
      },
    },
    async (request, reply) => {
      try {
        const [limit] = await db
          .update(schema.limitsTable)
          .set({ ...request.body, updatedAt: new Date() })
          .where(eq(schema.limitsTable.id, request.params.id))
          .returning();

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
        const result = await db
          .delete(schema.limitsTable)
          .where(eq(schema.limitsTable.id, request.params.id));

        if (result.rowCount === 0) {
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
