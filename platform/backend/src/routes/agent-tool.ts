import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { policyConfigurationService } from "@/agents/subagents/policy-configuration";
import {
  getAgentTypePermissionChecker,
  hasAnyAgentTypeAdminPermission,
  hasAnyAgentTypeReadPermission,
  isAgentTypeAdmin,
  requireAgentModifyPermission,
  requireAgentTypePermission,
} from "@/auth";
import { clearChatMcpClient } from "@/clients/chat-mcp-client";
import logger from "@/logging";
import {
  AgentModel,
  AgentToolModel,
  InternalMcpCatalogModel,
  McpServerModel,
  TeamModel,
  ToolModel,
} from "@/models";
import {
  assignToolToAgent,
  type PrefetchedMcpServer,
  validateAssignment,
} from "@/services/agent-tool-assignment";
import type { InternalMcpCatalog } from "@/types";
import {
  AgentToolAssignmentBodySchema,
  AgentToolFilterSchema,
  AgentToolSortBy,
  ApiError,
  BulkAgentToolAssignmentSchema,
  constructResponseSchema,
  createSortingQuerySchema,
  DeleteObjectResponseSchema,
  SelectAgentToolSchema,
  SelectToolSchema,
  UpdateAgentToolSchema,
  UuidIdSchema,
} from "@/types";

const agentToolRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/agent-tools",
    {
      schema: {
        operationId: RouteId.GetAllAgentTools,
        description:
          "Get all agent-tool relationships with pagination, sorting, and filtering",
        tags: ["Agent Tools"],
        querystring: createSortingQuerySchema(AgentToolSortBy)
          .merge(AgentToolFilterSchema)
          .merge(PaginationQuerySchema)
          .extend({
            skipPagination: z.coerce.boolean().optional(),
          }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectAgentToolSchema),
        ),
      },
    },
    async (
      {
        query: {
          limit,
          offset,
          sortBy,
          sortDirection,
          search,
          agentId,
          origin,
          mcpServerOwnerId,
          excludeArchestraTools,
          skipPagination,
        },
        organizationId,
        user,
      },
      reply,
    ) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

      const result = await AgentToolModel.findAll({
        pagination: { limit, offset },
        sorting: { sortBy, sortDirection },
        filters: {
          search,
          agentId,
          origin,
          mcpServerOwnerId,
          excludeArchestraTools,
        },
        userId: user.id,
        isAgentAdmin,
        skipPagination,
      });

      return reply.send(result);
    },
  );

  fastify.post(
    "/api/agents/:agentId/tools/:toolId",
    {
      schema: {
        operationId: RouteId.AssignToolToAgent,
        description: "Assign a tool to an agent",
        tags: ["Agent Tools"],
        params: z.object({
          agentId: UuidIdSchema,
          toolId: UuidIdSchema,
        }),
        body: AgentToolAssignmentBodySchema,
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request, reply) => {
      const { agentId, toolId } = request.params;
      const { mcpServerId, resolveAtCallTime, credentialResolutionMode } =
        request.body || {};

      // Check agent-type-specific modify permission based on scope
      const agent = await AgentModel.findById(agentId);
      if (!agent) {
        throw new ApiError(404, `Agent with ID ${agentId} not found`);
      }
      const checker = await getAgentTypePermissionChecker({
        userId: request.user.id,
        organizationId: request.organizationId,
      });
      checker.require(agent.agentType, "update");
      const userTeamIds = !checker.isAdmin(agent.agentType)
        ? await TeamModel.getUserTeamIds(request.user.id)
        : [];
      requireAgentModifyPermission({
        checker,
        agentType: agent.agentType,
        agentScope: agent.scope,
        agentAuthorId: agent.authorId,
        agentTeamIds: agent.teams.map((t) => t.id),
        userTeamIds,
        userId: request.user.id,
      });

      const result = await assignToolToAgent({
        agentId,
        toolId,
        mcpServerId,
        resolveAtCallTime,
        credentialResolutionMode,
      });

      if (result && result !== "duplicate" && result !== "updated") {
        throw new ApiError(
          mapAgentToolAssignmentErrorCodeToHttpStatus(result.code),
          result.error.message,
        );
      }

      // Clear chat MCP client cache to ensure fresh tools are fetched
      clearChatMcpClient(agentId);

      // Return success for new assignments, duplicates, and updates
      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/agents/tools/bulk-assign",
    {
      schema: {
        operationId: RouteId.BulkAssignTools,
        description: "Assign multiple tools to multiple agents in bulk",
        tags: ["Agent Tools"],
        body: z.object({
          assignments: z.array(BulkAgentToolAssignmentSchema),
        }),
        response: constructResponseSchema(
          z.object({
            succeeded: z.array(
              z.object({
                agentId: z.string(),
                toolId: z.string(),
              }),
            ),
            failed: z.array(
              z.object({
                agentId: z.string(),
                toolId: z.string(),
                error: z.string(),
              }),
            ),
            duplicates: z.array(
              z.object({
                agentId: z.string(),
                toolId: z.string(),
              }),
            ),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { assignments } = request.body;

      // Extract unique IDs for batch fetching to avoid N+1 queries
      const uniqueAgentIds = [...new Set(assignments.map((a) => a.agentId))];
      const uniqueToolIds = [...new Set(assignments.map((a) => a.toolId))];

      // Batch fetch agents for permission checks (avoids N+1 findById calls)
      const [agentsForPermCheck, checker] = await Promise.all([
        AgentModel.findByIdsForPermissionCheck(uniqueAgentIds),
        getAgentTypePermissionChecker({
          userId: request.user.id,
          organizationId: request.organizationId,
        }),
      ]);

      let userTeamIds: string[] | null = null;
      for (const [, agent] of agentsForPermCheck) {
        checker.require(agent.agentType, "update");
        if (!checker.isAdmin(agent.agentType) && userTeamIds === null) {
          userTeamIds = await TeamModel.getUserTeamIds(request.user.id);
        }
        requireAgentModifyPermission({
          checker,
          agentType: agent.agentType,
          agentScope: agent.scope,
          agentAuthorId: agent.authorId,
          agentTeamIds: agent.teamIds,
          userTeamIds: userTeamIds ?? [],
          userId: request.user.id,
        });
      }

      // Batch fetch all required data in parallel
      const existingAgentIds = new Set(agentsForPermCheck.keys());
      const tools = await ToolModel.getByIds(uniqueToolIds);

      // Create maps for efficient lookup
      const toolsMap = new Map(tools.map((tool) => [tool.id, tool]));

      // Extract unique catalog IDs from tools that have them
      const uniqueCatalogIds = [
        ...new Set(
          tools.filter((t) => t.catalogId).map((t) => t.catalogId as string),
        ),
      ];

      // Batch fetch catalog items if needed
      const catalogItemsMap =
        uniqueCatalogIds.length > 0
          ? await InternalMcpCatalogModel.getByIds(uniqueCatalogIds)
          : new Map<string, InternalMcpCatalog>();

      // Batch fetch unique MCP server IDs for static assignment validation
      const uniqueMcpServerIds = [
        ...new Set(
          assignments
            .map((a) => a.mcpServerId)
            .filter((id): id is string => id != null),
        ),
      ];
      const mcpServersBasicMap = new Map<string, PrefetchedMcpServer>();
      if (uniqueMcpServerIds.length > 0) {
        const servers = await McpServerModel.findByIdsBasic(uniqueMcpServerIds);
        for (const s of servers) {
          mcpServersBasicMap.set(s.id, s);
        }
      }

      // Prepare pre-fetched data to pass to assignToolToAgent for validation
      const preFetchedData = {
        existingAgentIds,
        toolsMap,
        catalogItemsMap,
        mcpServersBasicMap,
      };

      // Validate all assignments first (no DB writes)
      const validated: typeof assignments = [];
      const failed: { agentId: string; toolId: string; error: string }[] = [];

      for (const assignment of assignments) {
        const validationError = await validateAssignment({
          agentId: assignment.agentId,
          toolId: assignment.toolId,
          mcpServerId: assignment.mcpServerId,
          preFetchedData,
          resolveAtCallTime: assignment.resolveAtCallTime,
          credentialResolutionMode: assignment.credentialResolutionMode,
        });
        if (validationError) {
          failed.push({
            agentId: assignment.agentId,
            toolId: assignment.toolId,
            error: validationError.error.message,
          });
        } else {
          validated.push(assignment);
        }
      }

      // Bulk create-or-update all validated assignments
      const bulkResults = await AgentToolModel.bulkCreateOrUpdateCredentials(
        validated,
        request.organizationId,
      );

      const succeeded: { agentId: string; toolId: string }[] = [];
      const duplicates: { agentId: string; toolId: string }[] = [];

      for (const result of bulkResults) {
        if (result.status === "created" || result.status === "updated") {
          succeeded.push({ agentId: result.agentId, toolId: result.toolId });
        } else {
          duplicates.push({ agentId: result.agentId, toolId: result.toolId });
        }
      }

      // Clear chat MCP client cache for all affected agents
      const affectedAgentIds = new Set([
        ...succeeded.map((s) => s.agentId),
        ...duplicates.map((d) => d.agentId),
      ]);
      for (const agentId of affectedAgentIds) {
        clearChatMcpClient(agentId);
      }

      return reply.send({ succeeded, failed, duplicates });
    },
  );

  fastify.post(
    "/api/agent-tools/auto-configure-policies",
    {
      schema: {
        operationId: RouteId.AutoConfigureAgentToolPolicies,
        description:
          "Automatically configure security policies for tools using LLM analysis",
        tags: ["Agent Tools"],
        body: z.object({
          toolIds: z.array(z.string().uuid()).min(1),
        }),
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
            results: z.array(
              z.object({
                toolId: z.string().uuid(),
                success: z.boolean(),
                config: z
                  .object({
                    toolInvocationAction: z.enum([
                      "allow_when_context_is_untrusted",
                      "block_when_context_is_untrusted",
                      "block_always",
                    ]),
                    trustedDataAction: z.enum([
                      "mark_as_trusted",
                      "mark_as_untrusted",
                      "sanitize_with_dual_llm",
                      "block_always",
                    ]),
                    reasoning: z.string(),
                  })
                  .optional(),
                error: z.string().optional(),
              }),
            ),
          }),
        ),
      },
    },
    async ({ body, organizationId, user }, reply) => {
      const { toolIds } = body;

      logger.info(
        { organizationId, userId: user.id, count: toolIds.length },
        "POST /api/agent-tools/auto-configure-policies: request received",
      );

      // Pre-resolve LLM to give a clear 400 error if no API key is configured.
      // This resolved config is then threaded through to avoid redundant DB queries.
      const resolvedLlm = await policyConfigurationService.resolveLlm({
        organizationId,
        userId: user.id,
      });
      if (!resolvedLlm) {
        logger.warn(
          { organizationId, userId: user.id },
          "POST /api/agent-tools/auto-configure-policies: service not available",
        );
        throw new ApiError(
          400,
          "Auto-policy requires an LLM API key to be configured in LLM API Keys settings",
        );
      }

      const result = await policyConfigurationService.configurePoliciesForTools(
        {
          toolIds,
          organizationId,
          userId: user.id,
        },
      );

      logger.info(
        {
          organizationId,
          userId: user.id,
          success: result.success,
          resultsCount: result.results.length,
        },
        "POST /api/agent-tools/auto-configure-policies: completed",
      );

      return reply.send(result);
    },
  );

  fastify.delete(
    "/api/agents/:agentId/tools/:toolId",
    {
      schema: {
        operationId: RouteId.UnassignToolFromAgent,
        description: "Unassign a tool from an agent",
        tags: ["Agent Tools"],
        params: z.object({
          agentId: UuidIdSchema,
          toolId: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { agentId, toolId }, user, organizationId }, reply) => {
      // Check agent-type-specific modify permission based on scope
      const agent = await AgentModel.findById(agentId);
      if (!agent) {
        throw new ApiError(404, "Agent tool not found");
      }
      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      checker.require(agent.agentType, "update");
      const userTeamIds = !checker.isAdmin(agent.agentType)
        ? await TeamModel.getUserTeamIds(user.id)
        : [];
      requireAgentModifyPermission({
        checker,
        agentType: agent.agentType,
        agentScope: agent.scope,
        agentAuthorId: agent.authorId,
        agentTeamIds: agent.teams.map((t) => t.id),
        userTeamIds,
        userId: user.id,
      });

      const success = await AgentToolModel.delete(agentId, toolId);

      if (!success) {
        throw new ApiError(404, "Agent tool not found");
      }

      // Clear chat MCP client cache to ensure fresh tools are fetched
      clearChatMcpClient(agentId);

      return reply.send({ success });
    },
  );

  fastify.get(
    "/api/agents/:agentId/tools",
    {
      schema: {
        operationId: RouteId.GetAgentTools,
        description:
          "Get all tools for an agent (both proxy-sniffed and MCP tools)",
        tags: ["Agent Tools"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        response: constructResponseSchema(z.array(SelectToolSchema)),
      },
    },
    async ({ params: { agentId }, user, organizationId }, reply) => {
      // Validate that agent exists
      const agent = await AgentModel.findById(agentId);
      if (!agent) {
        throw new ApiError(404, `Agent with ID ${agentId} not found`);
      }

      // Check agent-type-specific read permission
      await requireAgentTypePermission({
        userId: user.id,
        organizationId,
        agentType: agent.agentType,
        action: "read",
      });

      const tools = await ToolModel.getToolsByAgent(agentId);

      return reply.send(tools);
    },
  );

  fastify.patch(
    "/api/agent-tools/:id",
    {
      schema: {
        operationId: RouteId.UpdateAgentTool,
        description: "Update an agent-tool relationship",
        tags: ["Agent Tools"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdateAgentToolSchema.pick({
          mcpServerId: true,
          credentialResolutionMode: true,
        }).partial(),
        response: constructResponseSchema(UpdateAgentToolSchema),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      const { mcpServerId, credentialResolutionMode } = body;

      // Fetch the agent-tool relationship (needed for permission check and validation)
      const agentToolForValidation = await AgentToolModel.findById(id);

      if (!agentToolForValidation) {
        throw new ApiError(
          404,
          `Agent-tool relationship with ID ${id} not found`,
        );
      }

      // Check agent-type-specific modify permission based on scope
      const agentForPerm = await AgentModel.findById(
        agentToolForValidation.agent.id,
      );
      if (agentForPerm) {
        const checker = await getAgentTypePermissionChecker({
          userId: user.id,
          organizationId,
        });
        checker.require(agentForPerm.agentType, "update");
        const userTeamIds = !checker.isAdmin(agentForPerm.agentType)
          ? await TeamModel.getUserTeamIds(user.id)
          : [];
        requireAgentModifyPermission({
          checker,
          agentType: agentForPerm.agentType,
          agentScope: agentForPerm.scope,
          agentAuthorId: agentForPerm.authorId,
          agentTeamIds: agentForPerm.teams.map((t) => t.id),
          userTeamIds,
          userId: user.id,
        });
      }

      const validationError = await validateAssignment({
        agentId: agentToolForValidation.agent.id,
        toolId: agentToolForValidation.tool.id,
        mcpServerId: mcpServerId ?? agentToolForValidation.mcpServerId,
        credentialResolutionMode:
          credentialResolutionMode ??
          agentToolForValidation.credentialResolutionMode,
      });

      if (validationError) {
        throw new ApiError(
          mapAgentToolAssignmentErrorCodeToHttpStatus(validationError.code),
          validationError.error.message,
        );
      }

      const agentTool = await AgentToolModel.update(id, {
        mcpServerId,
        credentialResolutionMode,
      });

      if (!agentTool) {
        throw new ApiError(
          404,
          `Agent-tool relationship with ID ${id} not found`,
        );
      }

      // Clear chat MCP client cache to ensure fresh tools are fetched
      clearChatMcpClient(agentTool.agentId);

      return reply.send(agentTool);
    },
  );

  // =============================================================================
  // Agent Delegation Routes (internal agents only)
  // =============================================================================

  /**
   * Get delegation targets for an internal agent
   */
  fastify.get(
    "/api/agents/:agentId/delegations",
    {
      schema: {
        operationId: RouteId.GetAgentDelegations,
        description:
          "Get all delegation targets for an agent. Not applicable to LLM proxies.",
        tags: ["Agent Delegations"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        response: constructResponseSchema(
          z.array(
            z.object({
              id: z.string().uuid(),
              name: z.string(),
              description: z.string().nullable(),
              systemPrompt: z.string().nullable(),
            }),
          ),
        ),
      },
    },
    async ({ params: { agentId }, organizationId, user }, reply) => {
      // Fetch agent first to determine its type (admin=true to bypass team filter)
      const agent = await AgentModel.findById(agentId, user.id, true);
      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      // Check read permission for this agent's type (return 404 to avoid leaking existence)
      try {
        await requireAgentTypePermission({
          userId: user.id,
          organizationId,
          agentType: agent.agentType,
          action: "read",
        });
      } catch {
        throw new ApiError(404, "Agent not found");
      }

      // Delegations allowed for agent, mcp_gateway, and profile (not llm_proxy)
      if (agent.agentType === "llm_proxy") {
        throw new ApiError(400, "LLM proxies cannot have subagents");
      }

      const admin = await isAgentTypeAdmin({
        userId: user.id,
        organizationId,
        agentType: agent.agentType,
      });

      // If not admin, verify team access
      if (!admin) {
        const filteredAgent = await AgentModel.findById(
          agentId,
          user.id,
          false,
        );
        if (!filteredAgent) {
          throw new ApiError(404, "Agent not found");
        }
      }

      const delegations = await AgentToolModel.getDelegationTargets(
        agentId,
        user.id,
        admin,
      );
      return reply.send(delegations);
    },
  );

  /**
   * Sync delegation targets for an agent (replace all with new list)
   */
  fastify.post(
    "/api/agents/:agentId/delegations",
    {
      schema: {
        operationId: RouteId.SyncAgentDelegations,
        description:
          "Sync delegation targets for an agent. Replaces all existing delegations with the new list. Not applicable to LLM proxies.",
        tags: ["Agent Delegations"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: z.object({
          targetAgentIds: z.array(UuidIdSchema),
        }),
        response: constructResponseSchema(
          z.object({
            added: z.array(z.string()),
            removed: z.array(z.string()),
          }),
        ),
      },
    },
    async ({ params: { agentId }, body, organizationId, user }, reply) => {
      // Fetch agent first to determine its type (admin=true to bypass team filter)
      const agent = await AgentModel.findById(agentId, user.id, true);
      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      // Check update permission and scope-based modify permission
      const syncChecker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      try {
        syncChecker.require(agent.agentType, "update");
      } catch {
        throw new ApiError(404, "Agent not found");
      }
      const syncUserTeamIds = !syncChecker.isAdmin(agent.agentType)
        ? await TeamModel.getUserTeamIds(user.id)
        : [];
      requireAgentModifyPermission({
        checker: syncChecker,
        agentType: agent.agentType,
        agentScope: agent.scope,
        agentAuthorId: agent.authorId,
        agentTeamIds: agent.teams.map((t) => t.id),
        userTeamIds: syncUserTeamIds,
        userId: user.id,
      });

      // Delegations allowed for agent, mcp_gateway, and profile (not llm_proxy)
      if (agent.agentType === "llm_proxy") {
        throw new ApiError(400, "LLM proxies cannot have subagents");
      }

      // Validate all target agents exist and are internal agents
      for (const targetAgentId of body.targetAgentIds) {
        const targetAgent = await AgentModel.findById(targetAgentId);
        if (!targetAgent) {
          throw new ApiError(404, `Target agent ${targetAgentId} not found`);
        }
        if (targetAgent.agentType !== "agent") {
          throw new ApiError(
            400,
            `Target agent ${targetAgentId} is not an internal agent`,
          );
        }
        // Prevent self-delegation
        if (targetAgentId === agentId) {
          throw new ApiError(400, "An agent cannot delegate to itself");
        }
      }

      const result = await AgentToolModel.syncDelegations(
        agentId,
        body.targetAgentIds,
      );

      // Clear chat MCP client cache
      clearChatMcpClient(agentId);

      return reply.send(result);
    },
  );

  /**
   * Remove a specific delegation from an agent
   */
  fastify.delete(
    "/api/agents/:agentId/delegations/:targetAgentId",
    {
      schema: {
        operationId: RouteId.DeleteAgentDelegation,
        description:
          "Remove a specific delegation from an agent. Not applicable to LLM proxies.",
        tags: ["Agent Delegations"],
        params: z.object({
          agentId: UuidIdSchema,
          targetAgentId: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async (
      { params: { agentId, targetAgentId }, organizationId, user },
      reply,
    ) => {
      // Fetch agent first to determine its type (admin=true to bypass team filter)
      const agent = await AgentModel.findById(agentId, user.id, true);
      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      // Check update permission and scope-based modify permission
      const delChecker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      try {
        delChecker.require(agent.agentType, "update");
      } catch {
        throw new ApiError(404, "Agent not found");
      }
      const delUserTeamIds = !delChecker.isAdmin(agent.agentType)
        ? await TeamModel.getUserTeamIds(user.id)
        : [];
      requireAgentModifyPermission({
        checker: delChecker,
        agentType: agent.agentType,
        agentScope: agent.scope,
        agentAuthorId: agent.authorId,
        agentTeamIds: agent.teams.map((t) => t.id),
        userTeamIds: delUserTeamIds,
        userId: user.id,
      });

      // Delegations allowed for agent, mcp_gateway, and profile (not llm_proxy)
      if (agent.agentType === "llm_proxy") {
        throw new ApiError(400, "LLM proxies cannot have subagents");
      }

      const success = await AgentToolModel.removeDelegation(
        agentId,
        targetAgentId,
      );

      if (!success) {
        throw new ApiError(404, "Delegation not found");
      }

      // Clear chat MCP client cache
      clearChatMcpClient(agentId);

      return reply.send({ success: true });
    },
  );

  /**
   * Get all delegation connections for canvas visualization
   */
  fastify.get(
    "/api/agent-delegations",
    {
      schema: {
        operationId: RouteId.GetAllDelegationConnections,
        description:
          "Get all agent delegation connections for canvas visualization.",
        tags: ["Agent Delegations"],
        response: constructResponseSchema(
          z.object({
            connections: z.array(
              z.object({
                sourceAgentId: z.string().uuid(),
                sourceAgentName: z.string(),
                targetAgentId: z.string().uuid(),
                targetAgentName: z.string(),
                toolId: z.string().uuid(),
              }),
            ),
            agents: z.array(
              z.object({
                id: z.string().uuid(),
                name: z.string(),
                agentType: z.enum([
                  "profile",
                  "mcp_gateway",
                  "llm_proxy",
                  "agent",
                ]),
              }),
            ),
          }),
        ),
      },
    },
    async ({ organizationId, user }, reply) => {
      // Require read on at least one agent-type resource
      const hasRead = await hasAnyAgentTypeReadPermission({
        userId: user.id,
        organizationId,
      });
      if (!hasRead) {
        throw new ApiError(403, "Forbidden");
      }

      const [connections, agents] = await Promise.all([
        AgentToolModel.getAllDelegationConnections(organizationId),
        AgentModel.findByOrganizationId(organizationId, { agentType: "agent" }),
      ]);

      return reply.send({
        connections,
        agents: agents.map((a) => ({
          id: a.id,
          name: a.name,
          agentType: a.agentType,
        })),
      });
    },
  );
};

function mapAgentToolAssignmentErrorCodeToHttpStatus(
  code: "not_found" | "validation_error",
): 400 | 404 {
  return code === "not_found" ? 404 : 400;
}

export default agentToolRoutes;
