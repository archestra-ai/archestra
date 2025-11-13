import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { OptimizationRuleModel } from "@/models";

const optimizationRuleRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Get all optimization rules for an agent
  fastify.get(
    "/api/agents/:agentId/optimization-rules",
    {
      schema: {
        operationId: RouteId.GetOptimizationRules,
        description: "Get all optimization rules for an agent",
        tags: ["Optimization Rules"],
        params: z.object({
          agentId: z.string().uuid(),
        }),
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              agentId: z.string(),
              ruleType: z.string(),
              conditions: z.unknown(),
              provider: z.string(),
              targetModel: z.string(),
              priority: z.number(),
              enabled: z.boolean(),
              createdAt: z.date(),
              updatedAt: z.date(),
            }),
          ),
        },
      },
    },
    async (request, reply) => {
      const { agentId } = request.params;

      const rules = await OptimizationRuleModel.findByAgentId(agentId);

      return reply.status(200).send(rules);
    },
  );

  // Create a new optimization rule
  fastify.post(
    "/api/agents/:agentId/optimization-rules",
    {
      schema: {
        operationId: RouteId.CreateOptimizationRule,
        description: "Create a new optimization rule for an agent",
        tags: ["Optimization Rules"],
        params: z.object({
          agentId: z.string().uuid(),
        }),
        body: z.object({
          ruleType: z.string().min(1),
          conditions: z.union([
            z.object({ maxLength: z.number().int().positive() }),
            z.object({ hasTools: z.boolean() }),
          ]),
          provider: z.string().min(1),
          targetModel: z.string().min(1),
          priority: z.number().int().default(0),
          enabled: z.boolean().default(true),
        }),
        response: {
          201: z.object({
            id: z.string(),
            agentId: z.string(),
            ruleType: z.string().min(1),
            conditions: z.unknown(),
            provider: z.string().min(1),
            targetModel: z.string(),
            priority: z.number(),
            enabled: z.boolean(),
            createdAt: z.date(),
            updatedAt: z.date(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { agentId } = request.params;
      const { ruleType, conditions, provider, targetModel, priority, enabled } =
        request.body;

      const rule = await OptimizationRuleModel.create({
        agentId,
        ruleType,
        conditions,
        provider,
        targetModel,
        priority,
        enabled,
      });

      return reply.status(201).send(rule);
    },
  );

  // Update an optimization rule
  fastify.put(
    "/api/optimization-rules/:id",
    {
      schema: {
        operationId: RouteId.UpdateOptimizationRule,
        description: "Update an optimization rule",
        tags: ["Optimization Rules"],
        params: z.object({
          id: z.string().uuid(),
        }),
        body: z.object({
          ruleType: z.string().min(1).optional(),
          conditions: z
            .union([
              z.object({ maxLength: z.number().int().positive() }),
              z.object({ hasTools: z.boolean() }),
            ])
            .optional(),
          provider: z.string().min(1).optional(),
          targetModel: z.string().min(1).optional(),
          priority: z.number().int().optional(),
          enabled: z.boolean().optional(),
        }),
        response: {
          200: z.object({
            id: z.string(),
            agentId: z.string(),
            ruleType: z.string().min(1),
            conditions: z.unknown(),
            provider: z.string().min(1),
            targetModel: z.string(),
            priority: z.number(),
            enabled: z.boolean(),
            createdAt: z.date(),
            updatedAt: z.date(),
          }),
          404: z.object({
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const updates = request.body;

      const rule = await OptimizationRuleModel.update(id, updates);

      if (!rule) {
        return reply
          .status(404)
          .send({ message: "Optimization rule not found" });
      }

      return reply.status(200).send(rule);
    },
  );

  // Delete an optimization rule
  fastify.delete(
    "/api/optimization-rules/:id",
    {
      schema: {
        operationId: RouteId.DeleteOptimizationRule,
        description: "Delete an optimization rule",
        tags: ["Optimization Rules"],
        params: z.object({
          id: z.string().uuid(),
        }),
        response: {
          204: z.null(),
          404: z.object({
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const deleted = await OptimizationRuleModel.delete(id);

      if (!deleted) {
        return reply
          .status(404)
          .send({ message: "Optimization rule not found" });
      }

      return reply.status(204).send();
    },
  );
};

export default optimizationRuleRoutes;
