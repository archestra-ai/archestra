import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getAgentTypePermissionChecker,
  hasAnyAgentTypeReadPermission,
} from "@/auth";
import { AgentLabelModel, AgentModel, TeamModel } from "@/models";
import { metrics } from "@/observability";
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
              .enum(["profile", "mcp_gateway", "llm_proxy", "agent"])
              .optional()
              .describe(
                "Filter by agent type. 'profile' = external API gateway profiles, 'mcp_gateway' = MCP gateway, 'llm_proxy' = LLM proxy, 'agent' = internal agents with prompts.",
              ),
            agentTypes: z
              .preprocess(
                (val) => (typeof val === "string" ? val.split(",") : val),
                z.array(
                  z.enum(["profile", "mcp_gateway", "llm_proxy", "agent"]),
                ),
              )
              .optional()
              .describe(
                "Filter by multiple agent types (comma-separated). Takes precedence over agentType if both provided.",
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
        query: {
          name,
          agentType,
          agentTypes,
          limit,
          offset,
          sortBy,
          sortDirection,
        },
        user,
        organizationId,
      },
      reply,
    ) => {
      // Determine the effective type filter
      const effectiveTypes =
        agentTypes || (agentType ? [agentType] : undefined);

      // Single DB query for all permission checks
      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });

      // Check read permission for the requested agent type(s)
      if (effectiveTypes) {
        for (const type of effectiveTypes) {
          checker.require(type, "read");
        }
      } else if (!checker.hasAnyReadPermission()) {
        throw new ApiError(403, "Forbidden");
      }

      // Check admin for the specific type(s) being queried, or any type if unfiltered
      const isAdmin = effectiveTypes
        ? effectiveTypes.length === 1
          ? checker.isAdmin(effectiveTypes[0])
          : checker.hasAnyAdminPermission()
        : checker.hasAnyAdminPermission();

      return reply.send(
        await AgentModel.findAllPaginated(
          { limit, offset },
          { sortBy, sortDirection },
          {
            name,
            // agentTypes takes precedence over agentType
            agentType: agentTypes ? undefined : agentType,
            agentTypes,
          },
          user.id,
          isAdmin,
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
            .enum(["profile", "mcp_gateway", "llm_proxy", "agent"])
            .optional()
            .describe(
              "Filter by agent type. 'profile' = external API gateway profiles, 'mcp_gateway' = MCP gateway, 'llm_proxy' = LLM proxy, 'agent' = internal agents with prompts.",
            ),
          agentTypes: z
            .preprocess(
              (val) => (typeof val === "string" ? val.split(",") : val),
              z.array(z.enum(["profile", "mcp_gateway", "llm_proxy", "agent"])),
            )
            .optional()
            .describe(
              "Filter by multiple agent types (comma-separated). Takes precedence over agentType if both provided.",
            ),
        }),
        response: constructResponseSchema(z.array(SelectAgentSchema)),
      },
    },
    async (
      { query: { agentType, agentTypes }, user, organizationId },
      reply,
    ) => {
      // Determine the effective type filter
      const effectiveTypes =
        agentTypes || (agentType ? [agentType] : undefined);

      // Single DB query for all permission checks
      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });

      // Check read permission for the requested agent type(s)
      if (effectiveTypes) {
        for (const type of effectiveTypes) {
          checker.require(type, "read");
        }
      } else if (!checker.hasAnyReadPermission()) {
        throw new ApiError(403, "Forbidden");
      }

      // Check admin for the specific type(s) being queried, or any type if unfiltered
      const isAdmin = effectiveTypes
        ? effectiveTypes.length === 1
          ? checker.isAdmin(effectiveTypes[0])
          : checker.hasAnyAdminPermission()
        : checker.hasAnyAdminPermission();

      return reply.send(
        await AgentModel.findAll(user.id, isAdmin, {
          // agentTypes takes precedence over agentType
          agentType: agentTypes ? undefined : agentType,
          agentTypes,
        }),
      );
    },
  );

  fastify.get(
    "/api/mcp-gateways/default",
    {
      schema: {
        operationId: RouteId.GetDefaultMcpGateway,
        description: "Get or create default MCP Gateway",
        tags: ["MCP Gateways"],
        response: constructResponseSchema(SelectAgentSchema),
      },
    },
    async (request, reply) => {
      return reply.send(
        await AgentModel.getMCPGatewayOrCreateDefault(request.organizationId),
      );
    },
  );

  fastify.get(
    "/api/llm-proxy/default",
    {
      schema: {
        operationId: RouteId.GetDefaultLlmProxy,
        description: "Get or create default LLM Proxy",
        tags: ["LLM Proxy"],
        response: constructResponseSchema(SelectAgentSchema),
      },
    },
    async (request, reply) => {
      return reply.send(
        await AgentModel.getLLMProxyOrCreateDefault(request.organizationId),
      );
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
    async ({ body, user, organizationId }, reply) => {
      // Check create permission for the specific agent type
      const agentType = body.agentType ?? "mcp_gateway";

      // Single DB query for all permission checks on this agent type
      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      checker.require(agentType, "create");

      // Validate team assignment for non-admin users
      if (!checker.isAdmin(agentType)) {
        const userTeamIds = await TeamModel.getUserTeamIds(user.id);

        if (body.teams.length === 0) {
          // Non-admin users must select at least one team they're a member of
          if (userTeamIds.length === 0) {
            throw new ApiError(
              403,
              "You must be a member of at least one team to create an agent",
            );
          }
          throw new ApiError(400, "You must assign at least one team");
        }

        // Verify user is a member of all specified teams
        const userTeamIdSet = new Set(userTeamIds);
        const invalidTeams = body.teams.filter((id) => !userTeamIdSet.has(id));
        if (invalidTeams.length > 0) {
          throw new ApiError(
            403,
            "You can only assign teams you are a member of",
          );
        }
      }

      const agent = await AgentModel.create(body);
      const labelKeys = await AgentLabelModel.getAllKeys();

      // We need to re-init metrics with the new label keys in case label keys changed.
      // Otherwise the newly added labels will not make it to metrics. The labels with new keys, that is.
      metrics.llm.initializeMetrics(labelKeys);
      metrics.mcp.initializeMcpMetrics(labelKeys);
      metrics.agentExecution.initializeAgentExecutionMetrics(labelKeys);

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
    async ({ params: { id }, user, organizationId }, reply) => {
      // Fetch agent first to determine its type
      // Use admin=true for the lookup so we can check type, then enforce type-specific RBAC
      const agent = await AgentModel.findById(id, user.id, true);

      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      // Single DB query for all permission checks on this agent type
      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });

      // Check read permission (return 404 to avoid leaking existence)
      try {
        checker.require(agent.agentType, "read");
      } catch {
        throw new ApiError(404, "Agent not found");
      }

      if (!checker.isAdmin(agent.agentType)) {
        // Re-fetch with team filtering
        const filteredAgent = await AgentModel.findById(id, user.id, false);
        if (!filteredAgent) {
          throw new ApiError(404, "Agent not found");
        }
        return reply.send(filteredAgent);
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
    async ({ params: { id }, body, user, organizationId }, reply) => {
      // Fetch agent to determine its type for permission check
      const existingAgent = await AgentModel.findById(id, user.id, true);
      if (!existingAgent) {
        throw new ApiError(404, "Agent not found");
      }

      // Single DB query for all permission checks on this agent type
      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });

      // Check update permission (return 404 to avoid leaking existence)
      try {
        checker.require(existingAgent.agentType, "update");
      } catch {
        throw new ApiError(404, "Agent not found");
      }

      // Validate team assignment for non-admin users if teams are being updated
      if (body.teams !== undefined) {
        if (!checker.isAdmin(existingAgent.agentType)) {
          const userTeamIds = await TeamModel.getUserTeamIds(user.id);

          if (body.teams.length === 0) {
            // Non-admin users must assign at least one team
            throw new ApiError(400, "You must assign at least one team");
          }

          // Verify user is a member of all specified teams
          const userTeamIdSet = new Set(userTeamIds);
          const invalidTeams = body.teams.filter(
            (teamId) => !userTeamIdSet.has(teamId),
          );
          if (invalidTeams.length > 0) {
            throw new ApiError(
              403,
              "You can only assign teams you are a member of",
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
      metrics.llm.initializeMetrics(labelKeys);
      metrics.mcp.initializeMcpMetrics(labelKeys);
      metrics.agentExecution.initializeAgentExecutionMetrics(labelKeys);

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
    async ({ params: { id }, user, organizationId }, reply) => {
      // Fetch agent to determine its type for permission check
      const agent = await AgentModel.findById(id, user.id, true);
      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      // Check delete permission for this agent's type (return 404 to avoid leaking existence)
      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      try {
        checker.require(agent.agentType, "delete");
      } catch {
        throw new ApiError(404, "Agent not found");
      }

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
    async ({ params: { id }, user, organizationId }, reply) => {
      // Fetch agent to determine its type
      const agent = await AgentModel.findById(id, user.id, true);
      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      // Single DB query for all permission checks on this agent type
      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });

      // Check read permission (return 404 to avoid leaking existence)
      try {
        checker.require(agent.agentType, "read");
      } catch {
        throw new ApiError(404, "Agent not found");
      }

      const versions = await AgentModel.getVersions(
        id,
        user.id,
        checker.isAdmin(agent.agentType),
      );

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
    async (
      { params: { id }, body: { version }, user, organizationId },
      reply,
    ) => {
      // Fetch agent to determine its type
      const agent = await AgentModel.findById(id, user.id, true);
      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      // Check update permission for this agent's type (return 404 to avoid leaking existence)
      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      try {
        checker.require(agent.agentType, "update");
      } catch {
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
    async ({ user, organizationId }, reply) => {
      const hasRead = await hasAnyAgentTypeReadPermission({
        userId: user.id,
        organizationId,
      });
      if (!hasRead) {
        throw new ApiError(403, "Forbidden");
      }
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
    async ({ query: { key }, user, organizationId }, reply) => {
      const hasRead = await hasAnyAgentTypeReadPermission({
        userId: user.id,
        organizationId,
      });
      if (!hasRead) {
        throw new ApiError(403, "Forbidden");
      }
      return reply.send(
        key
          ? await AgentLabelModel.getValuesByKey(key)
          : await AgentLabelModel.getAllValues(),
      );
    },
  );
};

export default agentRoutes;
