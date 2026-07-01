import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { LimitModel, OptimizationRuleModel } from "@/models";
import {
  ApiError,
  CreateLimitSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  LimitEntityTypeSchema,
  LimitTypeSchema,
  LimitWithUsageSchema,
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
        description:
          "Get all limits with optional filtering and per-model usage breakdown",
        tags: ["Limits"],
        querystring: z.object({
          entityType: LimitEntityTypeSchema.optional(),
          entityId: z.string().optional(),
          limitType: LimitTypeSchema.optional(),
        }),
        response: constructResponseSchema(z.array(LimitWithUsageSchema)),
      },
    },
    async (
      { query: { entityType, entityId, limitType }, organizationId },
      reply,
    ) => {
      // Cleanup limits if needed before fetching
      await LimitModel.cleanupLimitsIfNeeded({
        allForOrganizationId: organizationId,
        entityType,
        entityId,
        limitType,
      });

      // Ensure default token prices and optimization rules exist
      if (organizationId) {
        await OptimizationRuleModel.ensureDefaultOptimizationRules(
          organizationId,
        );
      }

      const limits = await LimitModel.findAll(
        entityType,
        entityId,
        limitType,
        organizationId,
      );

      // Add per-model usage breakdown for token_cost limits
      const limitsWithUsage = await Promise.all(
        limits.map(async (limit) => {
          if (limit.limitType === "token_cost") {
            const modelUsage = await LimitModel.getModelUsageBreakdown(
              limit.id,
            );
            return { ...limit, modelUsage };
          }
          return limit;
        }),
      );

      return reply.send(limitsWithUsage);
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
    async ({ body, organizationId }, reply) => {
      // Org-scoping: the limit's target entity must belong to the caller's
      // organization (limitsTable has no org column, so this is the tenancy
      // guard for cross-tenant entity IDs).
      const inOrg = await LimitModel.isEntityInOrganization(
        body.entityType,
        body.entityId,
        organizationId,
      );
      if (!inOrg) {
        throw new ApiError(404, `${body.entityType} not found`);
      }

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
    async ({ params: { id }, organizationId }, reply) => {
      const limit = await LimitModel.findByIdInOrganization(id, organizationId);

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
        // entityType/entityId are immutable: changing the target entity would
        // bypass the create-time org-scoping guard.
        body: UpdateLimitSchema.omit({
          entityType: true,
          entityId: true,
        }).partial(),
        response: constructResponseSchema(SelectLimitSchema),
      },
    },
    async ({ params: { id }, body, organizationId }, reply) => {
      const existing = await LimitModel.findByIdInOrganization(
        id,
        organizationId,
      );
      if (!existing) {
        throw new ApiError(404, "Limit not found");
      }

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
    async ({ params: { id }, organizationId }, reply) => {
      const existing = await LimitModel.findByIdInOrganization(
        id,
        organizationId,
      );
      if (!existing) {
        throw new ApiError(404, "Limit not found");
      }

      const deleted = await LimitModel.delete(id);

      if (!deleted) {
        throw new ApiError(404, "Limit not found");
      }

      return reply.send({ success: true });
    },
  );
};

export default limitsRoutes;
