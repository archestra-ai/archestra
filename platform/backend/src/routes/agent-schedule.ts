import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AgentModel,
  AgentScheduleModel,
  TeamModel,
} from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  InsertAgentScheduleSchema,
  SelectAgentScheduleSchema,
  UpdateAgentScheduleSchema,
  UuidIdSchema,
} from "@/types";
import { getAgentTypePermissionChecker, requireAgentModifyPermission } from "@/auth";

const agentScheduleRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/agent-schedules",
    {
      schema: {
        operationId: RouteId.GetAgentSchedules,
        description: "Get all agent schedules",
        tags: ["Schedules"],
        querystring: z.object({
          agentId: UuidIdSchema.optional(),
        }),
        response: constructResponseSchema(z.array(SelectAgentScheduleSchema)),
      },
    },
    async (request, reply) => {
      const { agentId } = request.query;
      // In a real app, we'd filter by user permissions/org
      const schedules = await AgentScheduleModel.findAllByAgentId(agentId);
      return reply.send(schedules);
    },
  );

  fastify.post(
    "/api/agent-schedules",
    {
      schema: {
        operationId: RouteId.CreateAgentSchedule,
        description: "Create a new agent schedule",
        tags: ["Schedules"],
        body: InsertAgentScheduleSchema,
        response: constructResponseSchema(SelectAgentScheduleSchema),
      },
    },
    async (request, reply) => {
      const { body, user, organizationId } = request;
      const agent = await AgentModel.findById(body.agentId, user.id, true);
      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });

      const userTeamIds = await TeamModel.getUserTeamIds(user.id);

      requireAgentModifyPermission({
        checker,
        agentType: agent.agentType,
        agentScope: agent.scope,
        agentAuthorId: agent.authorId,
        agentTeamIds: agent.teams.map((t) => t.id),
        userTeamIds,
        userId: user.id,
      });

      const schedule = await AgentScheduleModel.create(body);
      return reply.send(schedule);
    },
  );

  fastify.patch(
    "/api/agent-schedules/:id",
    {
      schema: {
        operationId: RouteId.UpdateAgentSchedule,
        description: "Update an agent schedule",
        tags: ["Schedules"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdateAgentScheduleSchema.partial(),
        response: constructResponseSchema(SelectAgentScheduleSchema),
      },
    },
    async (request, reply) => {
      const { params: { id }, body, user, organizationId } = request;
      const existing = await AgentScheduleModel.findById(id);
      if (!existing) {
        throw new ApiError(404, "Schedule not found");
      }

      const agent = await AgentModel.findById(existing.agentId, user.id, true);
      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);

      requireAgentModifyPermission({
        checker,
        agentType: agent.agentType,
        agentScope: agent.scope,
        agentAuthorId: agent.authorId,
        agentTeamIds: agent.teams.map((t) => t.id),
        userTeamIds,
        userId: user.id,
      });

      const updated = await AgentScheduleModel.update(id, body);
      if (!updated) {
        throw new ApiError(404, "Schedule not found");
      }
      return reply.send(updated);
    },
  );

  fastify.delete(
    "/api/agent-schedules/:id",
    {
      schema: {
        operationId: RouteId.DeleteAgentSchedule,
        description: "Delete an agent schedule",
        tags: ["Schedules"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async (request, reply) => {
      const { params: { id }, user, organizationId } = request;
      const existing = await AgentScheduleModel.findById(id);
      if (!existing) {
        throw new ApiError(404, "Schedule not found");
      }

      const agent = await AgentModel.findById(existing.agentId, user.id, true);
      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);

      requireAgentModifyPermission({
        checker,
        agentType: agent.agentType,
        agentScope: agent.scope,
        agentAuthorId: agent.authorId,
        agentTeamIds: agent.teams.map((t) => t.id),
        userTeamIds,
        userId: user.id,
      });

      await AgentScheduleModel.delete(id);
      return reply.send({ success: true });
    },
  );
};

export default agentScheduleRoutes;
