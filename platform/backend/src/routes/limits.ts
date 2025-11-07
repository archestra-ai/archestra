import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import db, { schema } from "@/database";
import TokenPriceModel from "@/models/token-price";
import { constructResponseSchema, RouteId, UuidIdSchema } from "@/types";
import {
  CreateLimitSchema,
  LimitEntityTypeSchema,
  LimitTypeSchema,
  SelectLimitSchema,
  UpdateLimitSchema,
} from "@/types/limit";
import { getUserFromRequest } from "@/utils";
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
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        // Cleanup limits if needed before fetching
        if (user.organizationId) {
          await cleanupLimitsIfNeeded(user.organizationId);
        }

        // Ensure all models from interactions have pricing records
        await TokenPriceModel.ensureAllModelsHavePricing();

        const conditions = [];

        if (request.query.entityType) {
          conditions.push(
            eq(schema.limitsTable.entityType, request.query.entityType),
          );
        }

        if (request.query.entityId) {
          conditions.push(
            eq(schema.limitsTable.entityId, request.query.entityId),
          );
        }

        if (request.query.limitType) {
          conditions.push(
            eq(schema.limitsTable.limitType, request.query.limitType),
          );
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
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

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
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

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
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

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
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

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
