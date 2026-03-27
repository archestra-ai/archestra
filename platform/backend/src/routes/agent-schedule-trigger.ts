import { RouteId } from "@shared";
import { Cron } from "croner";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { executeA2AMessage } from "@/agents/a2a-executor";
import logger from "@/logging";
import { AgentModel, AgentScheduleTriggerModel } from "@/models";
import {
  ApiError,
  CreateAgentScheduleTriggerBodySchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  SelectAgentScheduleTriggerSchema,
  UpdateAgentScheduleTriggerBodySchema,
} from "@/types";

const IdParamsSchema = z.object({ id: z.string().uuid() });

const agentScheduleTriggerRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/agent-schedule-triggers",
    {
      schema: {
        operationId: RouteId.GetAgentScheduleTriggers,
        description: "List all schedule triggers for the organization",
        tags: ["Agent Schedule Triggers"],
        querystring: z.object({
          agentId: z.string().uuid().optional(),
        }),
        response: constructResponseSchema(
          z.array(SelectAgentScheduleTriggerSchema),
        ),
      },
    },
    async ({ query, organizationId }, reply) => {
      const triggers = query.agentId
        ? await AgentScheduleTriggerModel.findByAgentId(query.agentId)
        : await AgentScheduleTriggerModel.findByOrganization(organizationId);

      return reply.send(triggers);
    },
  );

  fastify.get(
    "/api/agent-schedule-triggers/:id",
    {
      schema: {
        operationId: RouteId.GetAgentScheduleTrigger,
        description: "Get a schedule trigger by ID",
        tags: ["Agent Schedule Triggers"],
        params: IdParamsSchema,
        response: constructResponseSchema(SelectAgentScheduleTriggerSchema),
      },
    },
    async ({ params, organizationId }, reply) => {
      const trigger = await AgentScheduleTriggerModel.findByIdAndOrg({
        id: params.id,
        organizationId,
      });
      if (!trigger) throw new ApiError(404, "Schedule trigger not found");
      return reply.send(trigger);
    },
  );

  fastify.post(
    "/api/agent-schedule-triggers",
    {
      schema: {
        operationId: RouteId.CreateAgentScheduleTrigger,
        description: "Create a new schedule trigger for an agent",
        tags: ["Agent Schedule Triggers"],
        body: CreateAgentScheduleTriggerBodySchema,
        response: constructResponseSchema(SelectAgentScheduleTriggerSchema),
      },
    },
    async ({ body, organizationId }, reply) => {
      const agent = await AgentModel.findById(body.agentId);
      if (!agent) throw new ApiError(404, "Agent not found");

      if (body.triggerType === "cron" && body.cronExpression) {
        validateCronExpression(body.cronExpression);
      }

      const nextExecutionAt = computeInitialNextExecution(body);

      const trigger = await AgentScheduleTriggerModel.create({
        agentId: body.agentId,
        organizationId,
        name: body.name,
        triggerType: body.triggerType,
        enabled: body.enabled ?? true,
        cronExpression: body.cronExpression ?? undefined,
        intervalSeconds: body.intervalSeconds ?? undefined,
        scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : undefined,
        message: body.message ?? "",
        misfireGraceSeconds: body.misfireGraceSeconds ?? 300,
        nextExecutionAt,
        executionCount: 0,
        lastExecutedAt: null,
        lastError: null,
      });

      logger.info(
        {
          triggerId: trigger.id,
          agentId: body.agentId,
          triggerType: body.triggerType,
        },
        "Created agent schedule trigger",
      );

      return reply.send(trigger);
    },
  );

  fastify.put(
    "/api/agent-schedule-triggers/:id",
    {
      schema: {
        operationId: RouteId.UpdateAgentScheduleTrigger,
        description: "Update a schedule trigger",
        tags: ["Agent Schedule Triggers"],
        params: IdParamsSchema,
        body: UpdateAgentScheduleTriggerBodySchema,
        response: constructResponseSchema(SelectAgentScheduleTriggerSchema),
      },
    },
    async ({ params, body, organizationId }, reply) => {
      const existing = await AgentScheduleTriggerModel.findByIdAndOrg({
        id: params.id,
        organizationId,
      });
      if (!existing) throw new ApiError(404, "Schedule trigger not found");

      if (body.cronExpression) {
        validateCronExpression(body.cronExpression);
      }

      const merged = { ...existing, ...body };
      const nextExecutionAt = computeInitialNextExecution({
        triggerType: merged.triggerType,
        cronExpression: merged.cronExpression ?? undefined,
        intervalSeconds: merged.intervalSeconds ?? undefined,
        scheduledAt:
          merged.scheduledAt instanceof Date
            ? merged.scheduledAt.toISOString()
            : (merged.scheduledAt ?? undefined),
      });

      const updateData: Record<string, unknown> = { ...body, nextExecutionAt };
      if (typeof updateData.scheduledAt === "string") {
        updateData.scheduledAt = new Date(updateData.scheduledAt as string);
      }

      const trigger = await AgentScheduleTriggerModel.update(
        params.id,
        updateData as Parameters<typeof AgentScheduleTriggerModel.update>[1],
      );
      if (!trigger) throw new ApiError(404, "Schedule trigger not found");

      return reply.send(trigger);
    },
  );

  fastify.delete(
    "/api/agent-schedule-triggers/:id",
    {
      schema: {
        operationId: RouteId.DeleteAgentScheduleTrigger,
        description: "Delete a schedule trigger",
        tags: ["Agent Schedule Triggers"],
        params: IdParamsSchema,
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params, organizationId }, reply) => {
      const existing = await AgentScheduleTriggerModel.findByIdAndOrg({
        id: params.id,
        organizationId,
      });
      if (!existing) throw new ApiError(404, "Schedule trigger not found");

      await AgentScheduleTriggerModel.delete(params.id);

      logger.info(
        { triggerId: params.id, agentId: existing.agentId },
        "Deleted agent schedule trigger",
      );

      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/agent-schedule-triggers/:id/enable",
    {
      schema: {
        operationId: RouteId.EnableAgentScheduleTrigger,
        description: "Enable a schedule trigger",
        tags: ["Agent Schedule Triggers"],
        params: IdParamsSchema,
        response: constructResponseSchema(SelectAgentScheduleTriggerSchema),
      },
    },
    async ({ params, organizationId }, reply) => {
      const existing = await AgentScheduleTriggerModel.findByIdAndOrg({
        id: params.id,
        organizationId,
      });
      if (!existing) throw new ApiError(404, "Schedule trigger not found");

      const nextExecutionAt = computeInitialNextExecution({
        triggerType: existing.triggerType,
        cronExpression: existing.cronExpression ?? undefined,
        intervalSeconds: existing.intervalSeconds ?? undefined,
        scheduledAt: existing.scheduledAt?.toISOString(),
      });

      const trigger = await AgentScheduleTriggerModel.update(params.id, {
        enabled: true,
        nextExecutionAt,
      });
      if (!trigger) throw new ApiError(404, "Schedule trigger not found");

      return reply.send(trigger);
    },
  );

  fastify.post(
    "/api/agent-schedule-triggers/:id/disable",
    {
      schema: {
        operationId: RouteId.DisableAgentScheduleTrigger,
        description: "Disable a schedule trigger",
        tags: ["Agent Schedule Triggers"],
        params: IdParamsSchema,
        response: constructResponseSchema(SelectAgentScheduleTriggerSchema),
      },
    },
    async ({ params, organizationId }, reply) => {
      const existing = await AgentScheduleTriggerModel.findByIdAndOrg({
        id: params.id,
        organizationId,
      });
      if (!existing) throw new ApiError(404, "Schedule trigger not found");

      const trigger = await AgentScheduleTriggerModel.update(params.id, {
        enabled: false,
      });
      if (!trigger) throw new ApiError(404, "Schedule trigger not found");

      return reply.send(trigger);
    },
  );

  fastify.post(
    "/api/agent-schedule-triggers/:id/trigger",
    {
      schema: {
        operationId: RouteId.ManualTriggerAgentSchedule,
        description: "Manually trigger an agent schedule execution",
        tags: ["Agent Schedule Triggers"],
        params: IdParamsSchema,
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
            message: z.string(),
          }),
        ),
      },
    },
    async ({ params, organizationId, user }, reply) => {
      const trigger = await AgentScheduleTriggerModel.findByIdAndOrg({
        id: params.id,
        organizationId,
      });
      if (!trigger) throw new ApiError(404, "Schedule trigger not found");

      const agent = await AgentModel.findById(trigger.agentId);
      if (!agent) throw new ApiError(404, "Agent not found");

      try {
        await executeA2AMessage({
          agentId: trigger.agentId,
          message: trigger.message || `Manual execution: ${trigger.name}`,
          organizationId,
          userId: user.id,
          source: "schedule",
        });

        return reply.send({
          success: true,
          message: "Agent schedule trigger executed successfully",
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        throw new ApiError(500, `Trigger execution failed: ${errorMessage}`);
      }
    },
  );
};

export default agentScheduleTriggerRoutes;

// ===== Internal helpers =====

function validateCronExpression(expression: string): void {
  try {
    new Cron(expression);
  } catch {
    throw new ApiError(400, `Invalid cron expression: ${expression}`);
  }
}

function computeInitialNextExecution(params: {
  triggerType: string;
  cronExpression?: string;
  intervalSeconds?: number;
  scheduledAt?: string;
}): Date | null {
  if (params.triggerType === "cron" && params.cronExpression) {
    try {
      const cron = new Cron(params.cronExpression);
      return cron.nextRun() ?? null;
    } catch {
      return null;
    }
  }

  if (params.triggerType === "interval" && params.intervalSeconds) {
    return new Date(Date.now() + params.intervalSeconds * 1000);
  }

  if (params.triggerType === "one_time" && params.scheduledAt) {
    return new Date(params.scheduledAt);
  }

  return null;
}
