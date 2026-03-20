import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { executeA2AMessage } from "@/agents/a2a-executor";
import { scheduleManager } from "@/agents/schedule-manager";
import {
  AgentModel,
  AgentScheduleTriggerModel,
} from "@/models";
import { RouteId } from "@shared";
import {
  InsertAgentScheduleTriggerSchema,
  SelectAgentScheduleTriggerSchema,
} from "@/types";
import { FastifyInstanceWithZod } from "@/server";

const API_PREFIX = "/v1/organizations/:organizationId/agents/:agentId/agent-schedule-triggers";

export const agentScheduleTriggerRoutes: FastifyPluginAsync = async (
  fastify: FastifyInstanceWithZod,
) => {
  // Params schema for most routes
  const AgentTriggerParamsSchema = z.object({
    organizationId: z.string().uuid(),
    agentId: z.string().uuid(),
  });

  const TriggerIdParamsSchema = AgentTriggerParamsSchema.extend({
    triggerId: z.string().uuid(),
  });

  // Create
  fastify.post(
    API_PREFIX,
    {
      config: { routeId: RouteId.CreateAgentScheduleTrigger },
      schema: {
        tags: ["Agent Schedule Trigger"],
        summary: "Create a new schedule trigger for an agent",
        params: AgentTriggerParamsSchema,
        body: InsertAgentScheduleTriggerSchema.omit({
          id: true,
          agentId: true,
          organizationId: true,
          createdBy: true,
          createdAt: true,
        }),
        response: {
          201: SelectAgentScheduleTriggerSchema,
        },
      },
    },
    async (request, reply) => {
      const { organizationId, agentId } = request.params;
      const { user } = request;
      const payload = request.body;

      // Verify agent belongs to org
      const agent = await AgentModel.findById(agentId);
      if (!agent || agent.organizationId !== organizationId) {
        return reply.code(404).send({ error: { message: "Agent not found", type: "api_not_found" } as any });
      }

      const trigger = await AgentScheduleTriggerModel.create({
        ...payload,
        agentId,
        organizationId,
        createdBy: user.id,
      });

      // Schedule it if enabled
      if (trigger.enabled) {
        scheduleManager.scheduleTrigger(trigger);
      }

      return reply.code(201).send(trigger);
    },
  );

  // List
  fastify.get(
    API_PREFIX,
    {
      config: { routeId: RouteId.ListAgentScheduleTriggers },
      schema: {
        tags: ["Agent Schedule Trigger"],
        summary: "List all schedule triggers for an agent",
        params: AgentTriggerParamsSchema,
        response: {
          200: z.array(SelectAgentScheduleTriggerSchema),
        },
      },
    },
    async (request, reply) => {
      const { agentId } = request.params;
      const triggers = await AgentScheduleTriggerModel.findByAgentId(agentId);
      return reply.code(200).send(triggers);
    },
  );

  // Get
  fastify.get(
    `${API_PREFIX}/:triggerId`,
    {
      config: { routeId: RouteId.GetAgentScheduleTrigger },
      schema: {
        tags: ["Agent Schedule Trigger"],
        summary: "Get a specific schedule trigger",
        params: TriggerIdParamsSchema,
        response: {
          200: SelectAgentScheduleTriggerSchema,
        },
      },
    },
    async (request, reply) => {
      const { triggerId } = request.params;
      const trigger = await AgentScheduleTriggerModel.findById(triggerId);
      if (!trigger) {
        return reply.code(404).send({ error: { message: "Trigger not found", type: "api_not_found" } as any });
      }
      return reply.code(200).send(trigger);
    },
  );

  // Update
  fastify.patch(
    `${API_PREFIX}/:triggerId`,
    {
      config: { routeId: RouteId.UpdateAgentScheduleTrigger },
      schema: {
        tags: ["Agent Schedule Trigger"],
        summary: "Update a schedule trigger",
        params: TriggerIdParamsSchema,
        body: InsertAgentScheduleTriggerSchema.partial().omit({
          id: true,
          agentId: true,
          organizationId: true,
          createdBy: true,
          createdAt: true,
        }),
        response: {
          200: SelectAgentScheduleTriggerSchema,
        },
      },
    },
    async (request, reply) => {
      const { triggerId } = request.params;
      const payload = request.body;

      const trigger = await AgentScheduleTriggerModel.findById(triggerId);
      if (!trigger) {
        return reply.code(404).send({ error: { message: "Trigger not found", type: "api_not_found" } as any });
      }

      const updated = await AgentScheduleTriggerModel.update(triggerId, payload);
      if (!updated) {
         return reply.code(404).send({ error: { message: "Trigger not found", type: "api_not_found" } as any });
      }

      // Reschedule or unschedule based on new state
      if (updated.enabled) {
        scheduleManager.scheduleTrigger(updated);
      } else {
        scheduleManager.unscheduleTrigger(updated.id);
      }

      return reply.code(200).send(updated);
    },
  );

  // Delete
  fastify.delete(
    `${API_PREFIX}/:triggerId`,
    {
      config: { routeId: RouteId.DeleteAgentScheduleTrigger },
      schema: {
        tags: ["Agent Schedule Trigger"],
        summary: "Delete a schedule trigger",
        params: TriggerIdParamsSchema,
        response: {
          204: z.object({}),
        },
      },
    },
    async (request, reply) => {
      const { triggerId } = request.params;
      
      const trigger = await AgentScheduleTriggerModel.findById(triggerId);
      if (!trigger) {
        return reply.code(404).send({ error: { message: "Trigger not found", type: "api_not_found" } as any });
      }

      // Stop it if running
      scheduleManager.unscheduleTrigger(triggerId);

      await AgentScheduleTriggerModel.delete(triggerId);
      return reply.code(204).send({});
    },
  );

  // Enable
  fastify.post(
    `${API_PREFIX}/:triggerId/enable`,
    {
      config: { routeId: RouteId.EnableAgentScheduleTrigger },
      schema: {
        tags: ["Agent Schedule Trigger"],
        summary: "Enable a schedule trigger",
        params: TriggerIdParamsSchema,
        response: {
          200: SelectAgentScheduleTriggerSchema,
        },
      },
    },
    async (request, reply) => {
      const { triggerId } = request.params;
      
      const updated = await AgentScheduleTriggerModel.update(triggerId, { enabled: true });
      if (!updated) {
         return reply.code(404).send({ error: { message: "Trigger not found", type: "api_not_found" } as any });
      }
      
      scheduleManager.scheduleTrigger(updated);
      
      return reply.code(200).send(updated);
    },
  );

  // Disable
  fastify.post(
    `${API_PREFIX}/:triggerId/disable`,
    {
      config: { routeId: RouteId.DisableAgentScheduleTrigger },
      schema: {
        tags: ["Agent Schedule Trigger"],
        summary: "Disable a schedule trigger",
        params: TriggerIdParamsSchema,
        response: {
          200: SelectAgentScheduleTriggerSchema,
        },
      },
    },
    async (request, reply) => {
      const { triggerId } = request.params;
      
      const updated = await AgentScheduleTriggerModel.update(triggerId, { enabled: false });
      if (!updated) {
        return reply.code(404).send({ error: { message: "Trigger not found", type: "api_not_found" } as any });
      }
      
      scheduleManager.unscheduleTrigger(triggerId);
      
      return reply.code(200).send(updated);
    },
  );

  // Execute Manually
  fastify.post(
    `${API_PREFIX}/:triggerId/execute`,
    {
      config: { routeId: RouteId.ExecuteAgentScheduleTrigger },
      schema: {
        tags: ["Agent Schedule Trigger"],
        summary: "Manually execute a schedule trigger immediately",
        params: TriggerIdParamsSchema,
        response: {
          200: z.object({
            messageId: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { triggerId } = request.params;
      
      const trigger = await AgentScheduleTriggerModel.findById(triggerId);
      if (!trigger) {
        return reply.code(404).send({ error: { message: "Trigger not found", type: "api_not_found" } as any });
      }

      // We explicitly bypass the cron check and run the trigger action right here
      try {
        const result = await executeA2AMessage({
          agentId: trigger.agentId,
          message: trigger.inputMessage,
          organizationId: trigger.organizationId,
          userId: request.user.id, // Emulate execution as the person clicking the button
          source: "api" as any, 
        });
        
        // Log manual execution as success
        await AgentScheduleTriggerModel.recordExecution(trigger.id, {
           status: "success",
           nextExecuteAt: trigger.nextExecuteAt, // unmodified
        });

        return reply.code(200).send({ messageId: result.messageId });
      } catch (error) {
         // Log manual execution as failure
         await AgentScheduleTriggerModel.recordExecution(trigger.id, {
           status: "error",
           error: error instanceof Error ? error.message : String(error),
           nextExecuteAt: trigger.nextExecuteAt, // unmodified
         });
         
         throw error; // Let fastify errorHandler handle the 500 response
      }
    },
  );
};
