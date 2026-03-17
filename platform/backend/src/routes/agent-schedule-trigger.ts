import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { scheduleManager } from "@/agents/schedule/schedule-manager";
import logger from "@/logging";
import { AgentModel } from "@/models";
import AgentScheduleTriggerModel from "@/models/agent-schedule-trigger";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
} from "@/types";
import {
  CreateScheduleTriggerBodySchema,
  ScheduleTriggerResponseSchema,
  UpdateScheduleTriggerBodySchema,
} from "@/types/agent-schedule-trigger";

function serializeTrigger(trigger: {
  id: string;
  agentId: string;
  organizationId: string;
  name: string;
  triggerType: string;
  cronExpression: string | null;
  intervalSeconds: number | null;
  executeAt: Date | null;
  timezone: string;
  inputMessage: string;
  enabled: boolean;
  misfireGraceSeconds: number;
  lastExecutedAt: Date | null;
  nextExecuteAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
  executionCount: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: trigger.id,
    agentId: trigger.agentId,
    organizationId: trigger.organizationId,
    name: trigger.name,
    triggerType: trigger.triggerType,
    cronExpression: trigger.cronExpression,
    intervalSeconds: trigger.intervalSeconds,
    executeAt: trigger.executeAt?.toISOString() ?? null,
    timezone: trigger.timezone,
    inputMessage: trigger.inputMessage,
    enabled: trigger.enabled,
    misfireGraceSeconds: trigger.misfireGraceSeconds,
    lastExecutedAt: trigger.lastExecutedAt?.toISOString() ?? null,
    nextExecuteAt: trigger.nextExecuteAt?.toISOString() ?? null,
    lastStatus: trigger.lastStatus,
    lastError: trigger.lastError,
    executionCount: trigger.executionCount,
    createdBy: trigger.createdBy,
    createdAt: trigger.createdAt.toISOString(),
    updatedAt: trigger.updatedAt.toISOString(),
  };
}

const agentScheduleTriggerRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/api/agents/:agentId/schedule-triggers",
    {
      schema: {
        operationId: RouteId.CreateScheduleTrigger,
        description: "Create a schedule trigger for an agent",
        tags: ["Agent Schedule Triggers"],
        params: z.object({
          agentId: z.string().uuid(),
        }),
        body: CreateScheduleTriggerBodySchema,
        response: constructResponseSchema(ScheduleTriggerResponseSchema),
      },
    },
    async (request, reply) => {
      const { agentId } = request.params;
      const organizationId = request.organizationId;
      const userId = request.user.id;

      const agent = await AgentModel.findById(agentId);
      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }
      if (agent.agentType !== "agent") {
        throw new ApiError(
          400,
          "Schedule triggers can only be created for internal agents (agentType='agent')",
        );
      }

      const trigger = await AgentScheduleTriggerModel.create({
        agentId,
        organizationId,
        name: request.body.name,
        triggerType: request.body.triggerType,
        cronExpression: request.body.cronExpression ?? null,
        intervalSeconds: request.body.intervalSeconds ?? null,
        executeAt: request.body.executeAt
          ? new Date(request.body.executeAt)
          : null,
        timezone: request.body.timezone,
        inputMessage: request.body.inputMessage,
        enabled: request.body.enabled,
        misfireGraceSeconds: request.body.misfireGraceSeconds,
        createdBy: userId,
      });

      if (trigger.enabled) {
        scheduleManager.scheduleTrigger(trigger);
      }

      logger.info(
        {
          triggerId: trigger.id,
          agentId,
          triggerType: trigger.triggerType,
          userId,
        },
        "[ScheduleTrigger] Created schedule trigger",
      );

      return reply.status(201).send(serializeTrigger(trigger));
    },
  );

  fastify.get(
    "/api/agents/:agentId/schedule-triggers",
    {
      schema: {
        operationId: RouteId.GetScheduleTriggers,
        description: "List schedule triggers for an agent",
        tags: ["Agent Schedule Triggers"],
        params: z.object({
          agentId: z.string().uuid(),
        }),
        response: constructResponseSchema(
          z.array(ScheduleTriggerResponseSchema),
        ),
      },
    },
    async (request, reply) => {
      const { agentId } = request.params;
      const organizationId = request.organizationId;

      const triggers = await AgentScheduleTriggerModel.findByAgentId({
        agentId,
        organizationId,
      });

      return reply.send(triggers.map(serializeTrigger));
    },
  );

  fastify.get(
    "/api/schedule-triggers/:triggerId",
    {
      schema: {
        operationId: RouteId.GetScheduleTrigger,
        description: "Get a schedule trigger by ID",
        tags: ["Agent Schedule Triggers"],
        params: z.object({
          triggerId: z.string().uuid(),
        }),
        response: constructResponseSchema(ScheduleTriggerResponseSchema),
      },
    },
    async (request, reply) => {
      const { triggerId } = request.params;
      const organizationId = request.organizationId;

      const trigger =
        await AgentScheduleTriggerModel.findByIdAndOrganization({
          id: triggerId,
          organizationId,
        });

      if (!trigger) {
        throw new ApiError(404, "Schedule trigger not found");
      }

      return reply.send(serializeTrigger(trigger));
    },
  );

  fastify.patch(
    "/api/schedule-triggers/:triggerId",
    {
      schema: {
        operationId: RouteId.UpdateScheduleTrigger,
        description: "Update a schedule trigger",
        tags: ["Agent Schedule Triggers"],
        params: z.object({
          triggerId: z.string().uuid(),
        }),
        body: UpdateScheduleTriggerBodySchema,
        response: constructResponseSchema(ScheduleTriggerResponseSchema),
      },
    },
    async (request, reply) => {
      const { triggerId } = request.params;
      const organizationId = request.organizationId;

      const existing =
        await AgentScheduleTriggerModel.findByIdAndOrganization({
          id: triggerId,
          organizationId,
        });

      if (!existing) {
        throw new ApiError(404, "Schedule trigger not found");
      }

      const updateData: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(request.body)) {
        if (value !== undefined) {
          if (key === "executeAt" && typeof value === "string") {
            updateData[key] = new Date(value);
          } else {
            updateData[key] = value;
          }
        }
      }

      const trigger = await AgentScheduleTriggerModel.update({
        id: triggerId,
        organizationId,
        data: updateData as Parameters<
          typeof AgentScheduleTriggerModel.update
        >[0]["data"],
      });

      if (!trigger) {
        throw new ApiError(404, "Schedule trigger not found");
      }

      if (trigger.enabled) {
        scheduleManager.scheduleTrigger(trigger);
      } else {
        scheduleManager.removeTrigger(trigger.id);
      }

      logger.info(
        { triggerId: trigger.id, agentId: trigger.agentId },
        "[ScheduleTrigger] Updated schedule trigger",
      );

      return reply.send(serializeTrigger(trigger));
    },
  );

  fastify.delete(
    "/api/schedule-triggers/:triggerId",
    {
      schema: {
        operationId: RouteId.DeleteScheduleTrigger,
        description: "Delete a schedule trigger",
        tags: ["Agent Schedule Triggers"],
        params: z.object({
          triggerId: z.string().uuid(),
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async (request, reply) => {
      const { triggerId } = request.params;
      const organizationId = request.organizationId;

      const deleted = await AgentScheduleTriggerModel.delete({
        id: triggerId,
        organizationId,
      });

      if (!deleted) {
        throw new ApiError(404, "Schedule trigger not found");
      }

      scheduleManager.removeTrigger(triggerId);

      logger.info(
        { triggerId },
        "[ScheduleTrigger] Deleted schedule trigger",
      );

      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/schedule-triggers/:triggerId/enable",
    {
      schema: {
        operationId: RouteId.EnableScheduleTrigger,
        description: "Enable a schedule trigger",
        tags: ["Agent Schedule Triggers"],
        params: z.object({
          triggerId: z.string().uuid(),
        }),
        response: constructResponseSchema(ScheduleTriggerResponseSchema),
      },
    },
    async (request, reply) => {
      const { triggerId } = request.params;
      const organizationId = request.organizationId;

      const trigger = await AgentScheduleTriggerModel.setEnabled({
        id: triggerId,
        organizationId,
        enabled: true,
      });

      if (!trigger) {
        throw new ApiError(404, "Schedule trigger not found");
      }

      scheduleManager.scheduleTrigger(trigger);

      logger.info(
        { triggerId: trigger.id },
        "[ScheduleTrigger] Enabled schedule trigger",
      );

      return reply.send(serializeTrigger(trigger));
    },
  );

  fastify.post(
    "/api/schedule-triggers/:triggerId/disable",
    {
      schema: {
        operationId: RouteId.DisableScheduleTrigger,
        description: "Disable a schedule trigger",
        tags: ["Agent Schedule Triggers"],
        params: z.object({
          triggerId: z.string().uuid(),
        }),
        response: constructResponseSchema(ScheduleTriggerResponseSchema),
      },
    },
    async (request, reply) => {
      const { triggerId } = request.params;
      const organizationId = request.organizationId;

      const trigger = await AgentScheduleTriggerModel.setEnabled({
        id: triggerId,
        organizationId,
        enabled: false,
      });

      if (!trigger) {
        throw new ApiError(404, "Schedule trigger not found");
      }

      scheduleManager.removeTrigger(triggerId);

      logger.info(
        { triggerId: trigger.id },
        "[ScheduleTrigger] Disabled schedule trigger",
      );

      return reply.send(serializeTrigger(trigger));
    },
  );

  fastify.post(
    "/api/schedule-triggers/:triggerId/execute",
    {
      schema: {
        operationId: RouteId.ExecuteScheduleTrigger,
        description: "Manually execute a schedule trigger",
        tags: ["Agent Schedule Triggers"],
        params: z.object({
          triggerId: z.string().uuid(),
        }),
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
            message: z.string(),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { triggerId } = request.params;
      const organizationId = request.organizationId;

      const trigger =
        await AgentScheduleTriggerModel.findByIdAndOrganization({
          id: triggerId,
          organizationId,
        });

      if (!trigger) {
        throw new ApiError(404, "Schedule trigger not found");
      }

      scheduleManager
        .executeTrigger(trigger)
        .catch((error) => {
          logger.error(
            {
              triggerId,
              error: error instanceof Error ? error.message : String(error),
            },
            "[ScheduleTrigger] Manual execution failed",
          );
        });

      return reply.send({
        success: true,
        message: "Trigger execution started",
      });
    },
  );
};

export default agentScheduleTriggerRoutes;
