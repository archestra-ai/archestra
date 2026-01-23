import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { initializeMetrics } from "@/llm-metrics";
import { AgentLabelModel, AgentModel, TeamModel } from "@/models";
import {
  AgentVersionsResponseSchema,
  ApiError,
  constructResponseSchema,
  createPaginatedResponseSchema,
  createSortingQuerySchema,
  DeleteObjectResponseSchema,
  InsertAgentSchema,
  PaginationQuerySchema,
  SelectAgentSchema,
  UpdateAgentSchemaBase,
  UuidIdSchema,
} from "@/types";

const agentRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/agents",
    {
      schema: {
        operationId: RouteId.GetAgents,
        description: "Get all agents with pagination, sorting, and filtering",
        tags: ["Agents"],
        querystring: z
          .object({
            name: z.string().optional().describe("Filter by agent name"),
            agentType: z
              .enum(["mcp_gateway", "agent"])
              .optional()
              .describe(
                "Filter by agent type. 'agent' = internal agents with prompts, 'mcp_gateway' = external API gateway profiles.",
              ),
          })
          .merge(PaginationQuerySchema)
          .merge(
            createSortingQuerySchema([
              "name",
              "createdAt",
              "toolsCount",
              "team",
            ] as const),
          ),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectAgentSchema),
        ),
      },
    },
    async (
      {
        query: { name, agentType, limit, offset, sortBy, sortDirection },
        user,
        headers,
      },
      reply,
    ) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );
      return reply.send(
        await AgentModel.findAllPaginated(
          { limit, offset },
          { sortBy, sortDirection },
          {
            name,
            agentType,
          },
          user.id,
          isAgentAdmin,
        ),
      );
    },
  );

  fastify.get(
    "/api/agents/all",
    {
      schema: {
        operationId: RouteId.GetAllAgents,
        description: "Get all agents without pagination",
        tags: ["Agents"],
        querystring: z.object({
          agentType: z
            .enum(["mcp_gateway", "agent"])
            .optional()
            .describe(
              "Filter by agent type. 'agent' = internal agents with prompts, 'mcp_gateway' = external API gateway profiles.",
            ),
        }),
        response: constructResponseSchema(z.array(SelectAgentSchema)),
      },
    },
    async ({ query: { agentType }, headers, user }, reply) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );
      return reply.send(
        await AgentModel.findAll(user.id, isAgentAdmin, {
          agentType,
        }),
      );
    },
  );

  fastify.get(
    "/api/agents/default",
    {
      schema: {
        operationId: RouteId.GetDefaultAgent,
        description: "Get or create default agent",
        tags: ["Agents"],
        response: constructResponseSchema(SelectAgentSchema),
      },
    },
    async (_request, reply) => {
      return reply.send(await AgentModel.getAgentOrCreateDefault());
    },
  );

  fastify.post(
    "/api/agents",
    {
      schema: {
        operationId: RouteId.CreateAgent,
        description: "Create a new agent",
        tags: ["Agents"],
        body: InsertAgentSchema,
        response: constructResponseSchema(SelectAgentSchema),
      },
    },
    async ({ body, user, headers }, reply) => {
      const { success: isProfileAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      // Validate team assignment for non-admin users
      if (!isProfileAdmin) {
        const userTeamIds = await TeamModel.getUserTeamIds(user.id);

        if (body.teams.length === 0) {
          // Non-admin users must select at least one team they're a member of
          if (userTeamIds.length === 0) {
            throw new ApiError(
              403,
              "You must be a member of at least one team to create a profile",
            );
          }
          throw new ApiError(
            400,
            "You must assign at least one team to the profile",
          );
        }

        // Verify user is a member of all specified teams
        const userTeamIdSet = new Set(userTeamIds);
        const invalidTeams = body.teams.filter((id) => !userTeamIdSet.has(id));
        if (invalidTeams.length > 0) {
          throw new ApiError(
            403,
            "You can only assign profiles to teams you are a member of",
          );
        }
      }

      const agent = await AgentModel.create(body);
      const labelKeys = await AgentLabelModel.getAllKeys();

      // We need to re-init metrics with the new label keys in case label keys changed.
      // Otherwise the newly added labels will not make it to metrics. The labels with new keys, that is.
      initializeMetrics(labelKeys);

      return reply.send(agent);
    },
  );

  fastify.get(
    "/api/agents/:id",
    {
      schema: {
        operationId: RouteId.GetAgent,
        description: "Get agent by ID",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectAgentSchema),
      },
    },
    async ({ params: { id }, headers, user }, reply) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      const agent = await AgentModel.findById(id, user.id, isAgentAdmin);

      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      return reply.send(agent);
    },
  );

  fastify.put(
    "/api/agents/:id",
    {
      schema: {
        operationId: RouteId.UpdateAgent,
        description: "Update an agent",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdateAgentSchemaBase.partial(),
        response: constructResponseSchema(SelectAgentSchema),
      },
    },
    async ({ params: { id }, body, user, headers }, reply) => {
      // Validate team assignment for non-admin users if teams are being updated
      if (body.teams !== undefined) {
        const { success: isProfileAdmin } = await hasPermission(
          { profile: ["admin"] },
          headers,
        );

        if (!isProfileAdmin) {
          const userTeamIds = await TeamModel.getUserTeamIds(user.id);

          if (body.teams.length === 0) {
            // Non-admin users must assign at least one team
            throw new ApiError(
              400,
              "You must assign at least one team to the profile",
            );
          }

          // Verify user is a member of all specified teams
          const userTeamIdSet = new Set(userTeamIds);
          const invalidTeams = body.teams.filter(
            (teamId) => !userTeamIdSet.has(teamId),
          );
          if (invalidTeams.length > 0) {
            throw new ApiError(
              403,
              "You can only assign profiles to teams you are a member of",
            );
          }
        }
      }

      const agent = await AgentModel.update(id, body);

      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      const labelKeys = await AgentLabelModel.getAllKeys();
      // We need to re-init metrics with the new label keys in case label keys changed.
      // Otherwise the newly added labels will not make it to metrics. The labels with new keys, that is.
      initializeMetrics(labelKeys);

      return reply.send(agent);
    },
  );

  fastify.delete(
    "/api/agents/:id",
    {
      schema: {
        operationId: RouteId.DeleteAgent,
        description: "Delete an agent",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id } }, reply) => {
      const success = await AgentModel.delete(id);

      if (!success) {
        throw new ApiError(404, "Agent not found");
      }

      return reply.send({ success: true });
    },
  );

  // Version history endpoint (internal agents only)
  fastify.get(
    "/api/agents/:id/versions",
    {
      schema: {
        operationId: RouteId.GetAgentVersions,
        description:
          "Get version history for an internal agent. Only applicable to internal agents.",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(AgentVersionsResponseSchema),
      },
    },
    async ({ params: { id }, headers, user }, reply) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      const versions = await AgentModel.getVersions(id, user.id, isAgentAdmin);

      if (!versions) {
        throw new ApiError(
          404,
          "Agent not found or not an internal agent (versioning only applies to internal agents)",
        );
      }

      return reply.send(versions);
    },
  );

  // Rollback endpoint (internal agents only)
  fastify.post(
    "/api/agents/:id/rollback",
    {
      schema: {
        operationId: RouteId.RollbackAgent,
        description:
          "Rollback an internal agent to a previous version. Only applicable to internal agents.",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: z.object({
          version: z
            .number()
            .int()
            .positive()
            .describe("Version to rollback to"),
        }),
        response: constructResponseSchema(SelectAgentSchema),
      },
    },
    async ({ params: { id }, body: { version }, headers, user }, reply) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      // First verify the user has access to the agent
      const agent = await AgentModel.findById(id, user.id, isAgentAdmin);
      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      if (agent.agentType !== "agent") {
        throw new ApiError(
          400,
          "Rollback only applies to internal agents (agentType='agent')",
        );
      }

      const rolledBackAgent = await AgentModel.rollback(id, version);

      if (!rolledBackAgent) {
        throw new ApiError(404, "Version not found in agent history");
      }

      return reply.send(rolledBackAgent);
    },
  );

  fastify.get(
    "/api/agents/labels/keys",
    {
      schema: {
        operationId: RouteId.GetLabelKeys,
        description: "Get all available label keys",
        tags: ["Agents"],
        response: constructResponseSchema(z.array(z.string())),
      },
    },
    async (_request, reply) => {
      return reply.send(await AgentLabelModel.getAllKeys());
    },
  );

  fastify.get(
    "/api/agents/labels/values",
    {
      schema: {
        operationId: RouteId.GetLabelValues,
        description: "Get all available label values",
        tags: ["Agents"],
        querystring: z.object({
          key: z.string().optional().describe("Filter values by label key"),
        }),
        response: constructResponseSchema(z.array(z.string())),
      },
    },
    async ({ query: { key } }, reply) => {
      return reply.send(
        key
          ? await AgentLabelModel.getValuesByKey(key)
          : await AgentLabelModel.getAllValues(),
      );
    },
  );
};

export default agentRoutes;
