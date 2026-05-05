import {
  createPaginatedResponseSchema,
  LABELS_ENTRY_DELIMITER,
  LABELS_VALUE_DELIMITER,
  PaginationQuerySchema,
  RouteId,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getAgentTypePermissionChecker,
  hasAnyAgentTypeReadPermission,
  requireAgentModifyPermission,
} from "@/auth";
import { knowledgeSourceAccessControlService } from "@/knowledge-base";
import {
  AgentLabelModel,
  AgentModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  MemberModel,
  TeamModel,
} from "@/models";
import { initializeObservabilityMetrics } from "@/observability";
import {
  type AgentScope,
  AgentScopeFilterSchema,
  ApiError,
  BuiltInAgentConfigSchema,
  constructResponseSchema,
  createSortingQuerySchema,
  DeleteObjectResponseSchema,
  InsertAgentSchema,
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
            scope: AgentScopeFilterSchema.optional().describe(
              "Filter by scope: personal, team, org, or built_in.",
            ),
            teamIds: z
              .preprocess(
                (val) => (typeof val === "string" ? val.split(",") : val),
                z.array(z.string()),
              )
              .optional()
              .describe(
                "Filter by specific team IDs (comma-separated). Only used when scope=team.",
              ),
            authorIds: z
              .preprocess(
                (val) => (typeof val === "string" ? val.split(",") : val),
                z.array(z.string()),
              )
              .optional()
              .describe(
                "Filter by author user IDs (comma-separated). Admin-only, only used when scope=personal.",
              ),
            excludeAuthorIds: z
              .preprocess(
                (val) => (typeof val === "string" ? val.split(",") : val),
                z.array(z.string()),
              )
              .optional()
              .describe(
                "Exclude agents by author user IDs (comma-separated). Admin-only, only used when scope=personal.",
              ),
            labels: z
              .string()
              .optional()
              .describe(
                "Filter by labels. Format: key1:val1|val2;key2:val3. AND across keys, OR within values.",
              ),
            excludeOtherPersonalAgents: z
              .preprocess(
                (val) => (typeof val === "string" ? val === "true" : val),
                z.boolean(),
              )
              .optional()
              .describe(
                "Hide personal agents owned by other users. Admin-only; no-op for non-admins.",
              ),
          })
          .merge(PaginationQuerySchema)
          .merge(
            createSortingQuerySchema([
              "name",
              "createdAt",
              "toolsCount",
              "subagentsCount",
              "knowledgeSourcesCount",
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
          scope,
          teamIds,
          authorIds,
          excludeAuthorIds,
          labels,
          excludeOtherPersonalAgents,
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
            scope,
            teamIds,
            // authorIds and excludeAuthorIds are admin-only
            authorIds: isAdmin ? authorIds : undefined,
            excludeAuthorIds: isAdmin ? excludeAuthorIds : undefined,
            excludeOtherPersonalAgents: isAdmin
              ? excludeOtherPersonalAgents
              : undefined,
            labels: parseLabelsParam(labels),
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
          excludeBuiltIn: z
            .preprocess((val) => val === "true" || val === true, z.boolean())
            .optional()
            .describe(
              "Exclude built-in agents from the results. Defaults to false.",
            ),
          scope: AgentScopeFilterSchema.optional().describe(
            "Filter by scope: personal, team, org, or built_in.",
          ),
          excludeOtherPersonalAgents: z
            .preprocess(
              (val) => (typeof val === "string" ? val === "true" : val),
              z.boolean(),
            )
            .optional()
            .describe(
              "Hide personal agents owned by other users. Admin-only; no-op for non-admins (their access control already excludes them).",
            ),
        }),
        response: constructResponseSchema(z.array(SelectAgentSchema)),
      },
    },
    async (
      {
        query: {
          agentType,
          agentTypes,
          excludeBuiltIn,
          scope,
          excludeOtherPersonalAgents,
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
        await AgentModel.findAll(user.id, isAdmin, {
          // agentTypes takes precedence over agentType
          agentType: agentTypes ? undefined : agentType,
          agentTypes,
          excludeBuiltIn,
          scope:
            scope && scope !== "built_in" ? (scope as AgentScope) : undefined,
          excludeOtherPersonalAgents: isAdmin
            ? excludeOtherPersonalAgents
            : undefined,
        }),
      );
    },
  );

  fastify.get(
    "/api/mcp-gateways/default",
    {
      schema: {
        operationId: RouteId.GetDefaultMcpGateway,
        description: "Get default MCP Gateway",
        tags: ["MCP Gateway"],
        response: constructResponseSchema(SelectAgentSchema),
      },
    },
    async (request, reply) => {
      const gateway = await AgentModel.ensurePersonalMcpGateway({
        userId: request.user.id,
        organizationId: request.organizationId,
      });
      return reply.send(gateway);
    },
  );

  fastify.get(
    "/api/llm-proxy/default",
    {
      schema: {
        operationId: RouteId.GetDefaultLlmProxy,
        description: "Get default LLM Proxy",
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

      // Validate scope-based permissions for agent creation
      if (!checker.isAdmin(agentType)) {
        const scope = body.scope ?? "personal";
        if (scope === "org") {
          throw new ApiError(403, "Only admins can create org-scoped agents");
        }
        if (scope === "team" || body.teams.length > 0) {
          if (!checker.isTeamAdmin(agentType)) {
            throw new ApiError(
              403,
              "You need team-admin permission to create team-scoped agents",
            );
          }

          // team-admin can only assign teams they are a member of
          const userTeamIds = await TeamModel.getUserTeamIds(user.id);
          const userTeamIdSet = new Set(userTeamIds);
          const invalidTeams = body.teams.filter(
            (id) => !userTeamIdSet.has(id),
          );
          if (invalidTeams.length > 0) {
            throw new ApiError(
              403,
              "You can only assign teams you are a member of",
            );
          }
        }
      }

      // Validate knowledgeBaseIds if provided
      if (body.knowledgeBaseIds && body.knowledgeBaseIds.length > 0) {
        if (agentType === "llm_proxy") {
          throw new ApiError(
            400,
            "Knowledge bases cannot be assigned to LLM Proxy agents",
          );
        }
        const knowledgeSourceAccess =
          await knowledgeSourceAccessControlService.buildAccessControlContext({
            userId: user.id,
            organizationId,
          });
        for (const kbId of body.knowledgeBaseIds) {
          await validateKnowledgeBaseAccess({
            kbId,
            organizationId,
            access: knowledgeSourceAccess,
          });
        }
      }

      // Validate connectorIds if provided
      if (body.connectorIds && body.connectorIds.length > 0) {
        if (agentType === "llm_proxy") {
          throw new ApiError(
            400,
            "Connectors cannot be assigned to LLM Proxy agents",
          );
        }
        const knowledgeSourceAccess =
          await knowledgeSourceAccessControlService.buildAccessControlContext({
            userId: user.id,
            organizationId,
          });
        for (const connectorId of body.connectorIds) {
          await validateConnectorAccess({
            connectorId,
            organizationId,
            access: knowledgeSourceAccess,
          });
        }
      }

      // Omit teams if scope is not 'team' — scope takes precedence
      const createData = {
        ...body,
        ...(body.scope !== "team" && { teams: [] }),
      };
      const agent = await AgentModel.create(createData, user.id);
      // We need to re-init metrics with the new label keys in case label keys changed.
      // Otherwise the newly added labels will not make it to metrics. The labels with new keys, that is.
      await initializeObservabilityMetrics();

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

  fastify.post(
    "/api/agents/:id/clone",
    {
      schema: {
        operationId: RouteId.CloneAgent,
        description: "Clone an agent and all its associations",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectAgentSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      // Fetch agent first to determine its type for permission checks
      const sourceAgent = await AgentModel.findById(id, user.id, true);
      if (!sourceAgent) {
        throw new ApiError(404, "Agent not found");
      }

      // Prevent cross-organization cloning: the permission checker is scoped
      // to the caller's org, so an agent from a different org would bypass
      // those checks. Return 404 to avoid leaking existence.
      if (sourceAgent.organizationId !== organizationId) {
        throw new ApiError(404, "Agent not found");
      }

      // Disallow cloning built-in agents (Phase 1 policy)
      if (sourceAgent.builtInAgentConfig) {
        throw new ApiError(403, "Built-in agents cannot be cloned");
      }

      // Single DB query for all permission checks on this agent type
      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });

      // Check read + create permission (return 404 to avoid leaking existence)
      try {
        checker.require(sourceAgent.agentType, "read");
        checker.require(sourceAgent.agentType, "create");
      } catch {
        throw new ApiError(404, "Agent not found");
      }

      // Enforce scope-based modify permissions on the source agent
      const userTeamIds = !checker.isAdmin(sourceAgent.agentType)
        ? await TeamModel.getUserTeamIds(user.id)
        : [];
      requireAgentModifyPermission({
        checker,
        agentType: sourceAgent.agentType,
        agentScope: sourceAgent.scope,
        agentAuthorId: sourceAgent.authorId,
        agentTeamIds: sourceAgent.teams.map((t) => t.id),
        userTeamIds,
        userId: user.id,
      });

      // Validate knowledgeBaseIds if provided
      if ((sourceAgent.knowledgeBaseIds?.length ?? 0) > 0) {
        if (sourceAgent.agentType === "llm_proxy") {
          throw new ApiError(
            400,
            "Knowledge bases cannot be assigned to LLM Proxy agents",
          );
        }
        const knowledgeSourceAccess =
          await knowledgeSourceAccessControlService.buildAccessControlContext({
            userId: user.id,
            organizationId,
          });
        for (const kbId of sourceAgent.knowledgeBaseIds) {
          await validateKnowledgeBaseAccess({
            kbId,
            organizationId,
            access: knowledgeSourceAccess,
          });
        }
      }

      // Validate connectorIds if provided
      if ((sourceAgent.connectorIds?.length ?? 0) > 0) {
        if (sourceAgent.agentType === "llm_proxy") {
          throw new ApiError(
            400,
            "Connectors cannot be assigned to LLM Proxy agents",
          );
        }
        const knowledgeSourceAccess =
          await knowledgeSourceAccessControlService.buildAccessControlContext({
            userId: user.id,
            organizationId,
          });
        for (const connectorId of sourceAgent.connectorIds) {
          await validateConnectorAccess({
            connectorId,
            organizationId,
            access: knowledgeSourceAccess,
          });
        }
      }

      // Delegate cloning logic to the model
      const clonedAgent = await AgentModel.cloneAgent({
        sourceId: sourceAgent.id,
        userId: user.id,
      });

      return reply.send(clonedAgent);
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

      // Fetch user's team IDs once for scope-based checks and team assignment validation
      const userTeamIds = !checker.isAdmin(existingAgent.agentType)
        ? await TeamModel.getUserTeamIds(user.id)
        : [];

      // Enforce scope-based modify permissions on the existing agent
      requireAgentModifyPermission({
        checker,
        agentType: existingAgent.agentType,
        agentScope: existingAgent.scope,
        agentAuthorId: existingAgent.authorId,
        agentTeamIds: existingAgent.teams.map((t) => t.id),
        userTeamIds,
        userId: user.id,
      });

      // Validate scope escalation for non-admin users
      if (!checker.isAdmin(existingAgent.agentType)) {
        if (body.scope === "org") {
          throw new ApiError(403, "Only admins can set scope to org");
        }
        if (body.scope === "team" || (body.teams && body.teams.length > 0)) {
          if (!checker.isTeamAdmin(existingAgent.agentType)) {
            throw new ApiError(
              403,
              "You need team-admin permission to set scope to team",
            );
          }
        }

        // team-admin: validate team assignments and preserve teams they don't control
        if (checker.isTeamAdmin(existingAgent.agentType) && body.teams) {
          const userTeamIdSet = new Set(userTeamIds);
          const existingTeamIds = new Set(existingAgent.teams.map((t) => t.id));

          // Validate newly added teams — must be a member
          const invalidAdds = body.teams.filter(
            (id) => !existingTeamIds.has(id) && !userTeamIdSet.has(id),
          );
          if (invalidAdds.length > 0) {
            throw new ApiError(
              403,
              "You can only assign teams you are a member of",
            );
          }

          // Preserve existing teams the user doesn't control
          const preservedTeams = [...existingTeamIds].filter(
            (id) => !userTeamIdSet.has(id),
          );
          const userControlledTeams = body.teams.filter((id) =>
            userTeamIdSet.has(id),
          );
          body.teams = [
            ...new Set([...userControlledTeams, ...preservedTeams]),
          ];
        }
      }

      // Prevent downgrading shared agents to personal
      if (body.scope === "personal" && existingAgent.scope !== "personal") {
        throw new ApiError(400, "Shared agents cannot be made personal");
      }

      // Validate knowledgeBaseIds if provided
      if (body.knowledgeBaseIds && body.knowledgeBaseIds.length > 0) {
        if (existingAgent.agentType === "llm_proxy") {
          throw new ApiError(
            400,
            "Knowledge bases cannot be assigned to LLM Proxy agents",
          );
        }
        const knowledgeSourceAccess =
          await knowledgeSourceAccessControlService.buildAccessControlContext({
            userId: user.id,
            organizationId,
          });
        for (const kbId of body.knowledgeBaseIds) {
          await validateKnowledgeBaseAccess({
            kbId,
            organizationId,
            access: knowledgeSourceAccess,
          });
        }
      }

      // Validate connectorIds if provided
      if (body.connectorIds && body.connectorIds.length > 0) {
        if (existingAgent.agentType === "llm_proxy") {
          throw new ApiError(
            400,
            "Connectors cannot be assigned to LLM Proxy agents",
          );
        }
        const knowledgeSourceAccess =
          await knowledgeSourceAccessControlService.buildAccessControlContext({
            userId: user.id,
            organizationId,
          });
        for (const connectorId of body.connectorIds) {
          await validateConnectorAccess({
            connectorId,
            organizationId,
            access: knowledgeSourceAccess,
          });
        }
      }

      // Built-in agent guard: restrict which fields can be modified
      let updateData: typeof body;
      if (existingAgent.builtInAgentConfig) {
        // Validate builtInAgentConfig if provided
        if (body.builtInAgentConfig) {
          const parsed = BuiltInAgentConfigSchema.safeParse(
            body.builtInAgentConfig,
          );
          if (!parsed.success) {
            throw new ApiError(400, "Invalid built-in agent configuration");
          }
        }

        // Only allow specific fields for built-in agents.
        updateData = {
          ...(body.builtInAgentConfig !== undefined && {
            builtInAgentConfig: body.builtInAgentConfig,
          }),
          ...(body.systemPrompt !== undefined && {
            systemPrompt: body.systemPrompt,
          }),
          ...(body.llmApiKeyId !== undefined && {
            llmApiKeyId: body.llmApiKeyId,
          }),
          ...(body.llmModel !== undefined && { llmModel: body.llmModel }),
          ...(body.scope !== undefined && { scope: body.scope }),
          ...(body.teams !== undefined && { teams: body.teams }),
        };
      } else {
        // Omit teams if scope is not 'team' — scope takes precedence
        updateData = {
          ...body,
          ...((body.scope ?? existingAgent.scope) !== "team" &&
            body.teams !== undefined && { teams: [] }),
        };
      }

      const agent = await AgentModel.update(id, updateData);

      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      // Only re-init metrics when labels were part of the update payload,
      // since that's the only field that can introduce new label keys.
      if (body.labels !== undefined) {
        await initializeObservabilityMetrics();
      }

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

      // Enforce scope-based modify permissions
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

      // Prevent deletion of built-in agents
      if (agent.builtInAgentConfig) {
        throw new ApiError(403, "Built-in agents cannot be deleted");
      }

      // Prevent deletion of an agent that is any member's default
      const isDefault = await MemberModel.isAgentDefault(id);
      if (isDefault) {
        throw new ApiError(
          403,
          "Cannot delete a default agent. Set another agent as default first.",
        );
      }

      // Prevent deletion of a user's personal MCP gateway
      if (agent.isPersonalGateway) {
        throw new ApiError(403, "Personal MCP gateways cannot be deleted.");
      }

      const success = await AgentModel.delete(id);

      if (!success) {
        throw new ApiError(404, "Agent not found");
      }

      return reply.send({ success: true });
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
  fastify.get(
    "/api/members/default-agent",
    {
      schema: {
        operationId: RouteId.GetMemberDefaultAgent,
        description: "Get the current user's default agent ID",
        tags: ["Members"],
        response: constructResponseSchema(
          z.object({ defaultAgentId: z.string().uuid().nullable() }),
        ),
      },
    },
    async ({ user, organizationId }, reply) => {
      const defaultAgentId = await MemberModel.getDefaultAgentId(
        user.id,
        organizationId,
      );
      return reply.send({ defaultAgentId });
    },
  );
};

export default agentRoutes;

async function validateKnowledgeBaseAccess(params: {
  kbId: string;
  organizationId: string;
  access: Awaited<
    ReturnType<
      typeof knowledgeSourceAccessControlService.buildAccessControlContext
    >
  >;
}) {
  const kb = await KnowledgeBaseModel.findById(params.kbId);
  if (
    !kb ||
    kb.organizationId !== params.organizationId ||
    !knowledgeSourceAccessControlService.canAccessKnowledgeBase(
      params.access,
      kb,
    )
  ) {
    throw new ApiError(404, `Knowledge base not found: ${params.kbId}`);
  }
}

async function validateConnectorAccess(params: {
  connectorId: string;
  organizationId: string;
  access: Awaited<
    ReturnType<
      typeof knowledgeSourceAccessControlService.buildAccessControlContext
    >
  >;
}) {
  const connector = await KnowledgeBaseConnectorModel.findById(
    params.connectorId,
  );
  if (
    !connector ||
    connector.organizationId !== params.organizationId ||
    !knowledgeSourceAccessControlService.canAccessConnector(
      params.access,
      connector,
    )
  ) {
    throw new ApiError(404, `Connector not found: ${params.connectorId}`);
  }
}

function parseLabelsParam(
  labels: string | undefined,
): Record<string, string[]> | undefined {
  if (!labels) return undefined;
  const result: Record<string, string[]> = {};
  for (const entry of labels.split(LABELS_ENTRY_DELIMITER)) {
    const colonIdx = entry.indexOf(":");
    if (colonIdx === -1) continue;
    const key = entry.slice(0, colonIdx).trim();
    const values = entry
      .slice(colonIdx + 1)
      .split(LABELS_VALUE_DELIMITER)
      .map((v) => v.trim())
      .filter(Boolean);
    if (key && values.length > 0) {
      result[key] = values;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
