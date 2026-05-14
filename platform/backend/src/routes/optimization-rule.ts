import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { OptimizationRuleModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  InsertOptimizationRuleSchema,
  SelectOptimizationRuleSchema,
  UpdateOptimizationRuleSchema,
  UuidIdSchema,
} from "@/types";

const optimizationRuleRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/optimization-rules",
    {
      schema: {
        operationId: RouteId.GetOptimizationRules,
        description: "Get all optimization rules for the organization",
        tags: ["Optimization Rules"],
        response: constructResponseSchema(
          z.array(SelectOptimizationRuleSchema),
        ),
      },
    },
    async (request, reply) => {
      const rules = await OptimizationRuleModel.findByOrganizationId(
        request.organizationId,
      );

      return reply.status(200).send(rules);
    },
  );

  fastify.post(
    "/api/optimization-rules",
    {
      schema: {
        operationId: RouteId.CreateOptimizationRule,
        description: "Create a new optimization rule for the organization",
        tags: ["Optimization Rules"],
        body: InsertOptimizationRuleSchema,
        response: constructResponseSchema(SelectOptimizationRuleSchema),
      },
    },
    async (request, reply) => {
      const entityBelongsToOrganization =
        await OptimizationRuleModel.entityBelongsToOrganization(
          request.body.entityType,
          request.body.entityId,
          request.organizationId,
        );

      if (!entityBelongsToOrganization) {
        throw new ApiError(
          403,
          "Cannot create rule for different organization",
        );
      }

      const rule = await OptimizationRuleModel.create(request.body);

      return reply.send(rule);
    },
  );

  fastify.get(
    "/api/optimization-rules/:id",
    {
      schema: {
        operationId: RouteId.GetOptimizationRule,
        description: "Get an optimization rule by ID",
        tags: ["Optimization Rules"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectOptimizationRuleSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      const rule = await OptimizationRuleModel.findByIdForOrganization(
        id,
        organizationId,
      );

      if (!rule) {
        throw new ApiError(404, "Optimization rule not found");
      }

      return reply.send(rule);
    },
  );

  fastify.put(
    "/api/optimization-rules/:id",
    {
      schema: {
        operationId: RouteId.UpdateOptimizationRule,
        description: "Update an optimization rule",
        tags: ["Optimization Rules"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdateOptimizationRuleSchema.partial(),
        response: constructResponseSchema(SelectOptimizationRuleSchema),
      },
    },
    async ({ params: { id }, body, organizationId }, reply) => {
      const existingRule = await OptimizationRuleModel.findByIdForOrganization(
        id,
        organizationId,
      );

      if (!existingRule) {
        throw new ApiError(404, "Optimization rule not found");
      }

      const entityType = body.entityType ?? existingRule.entityType;
      const entityId = body.entityId ?? existingRule.entityId;
      const entityBelongsToOrganization =
        await OptimizationRuleModel.entityBelongsToOrganization(
          entityType,
          entityId,
          organizationId,
        );

      if (!entityBelongsToOrganization) {
        throw new ApiError(
          403,
          "Cannot update rule for different organization",
        );
      }

      const rule = await OptimizationRuleModel.update(id, body);

      if (!rule) {
        throw new ApiError(404, "Optimization rule not found");
      }

      return reply.send(rule);
    },
  );

  fastify.delete(
    "/api/optimization-rules/:id",
    {
      schema: {
        operationId: RouteId.DeleteOptimizationRule,
        description: "Delete an optimization rule",
        tags: ["Optimization Rules"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      const existingRule = await OptimizationRuleModel.findByIdForOrganization(
        id,
        organizationId,
      );

      if (!existingRule) {
        throw new ApiError(404, "Optimization rule not found");
      }

      const deleted = await OptimizationRuleModel.delete(id);

      if (!deleted) {
        throw new ApiError(404, "Optimization rule not found");
      }

      return reply.send({ success: true });
    },
  );
};

export default optimizationRuleRoutes;
