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
    "/api/agents/:agentId/optimization-rules",
    {
      schema: {
        operationId: RouteId.GetOptimizationRules,
        description: "Get all optimization rules for an agent",
        tags: ["Optimization Rules"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        response: constructResponseSchema(
          z.array(SelectOptimizationRuleSchema),
        ),
      },
    },
    async (request, reply) => {
      const { agentId } = request.params;

      const rules = await OptimizationRuleModel.findByAgentId(agentId);

      return reply.status(200).send(rules);
    },
  );

  fastify.post(
    "/api/agents/:agentId/optimization-rules",
    {
      schema: {
        operationId: RouteId.CreateOptimizationRule,
        description: "Create a new optimization rule for an agent",
        tags: ["Optimization Rules"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: InsertOptimizationRuleSchema.omit({ agentId: true }),
        response: constructResponseSchema(SelectOptimizationRuleSchema),
      },
    },
    async ({ params: { agentId }, body }, reply) => {
      const rule = await OptimizationRuleModel.create({
        ...body,
        agentId,
      });

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
    async ({ params: { id }, body }, reply) => {
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
    async ({ params: { id } }, reply) => {
      const deleted = await OptimizationRuleModel.delete(id);

      if (!deleted) {
        throw new ApiError(404, "Optimization rule not found");
      }

      return reply.send({ success: true });
    },
  );
};

export default optimizationRuleRoutes;
