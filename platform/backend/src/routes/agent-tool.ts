import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
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
import db, { type Transaction } from "@/database";
import logger from "@/logging";
import {
  AgentModel,
  AgentToolModel,
  AgentVersionModel,
  InternalMcpCatalogModel,
  McpServerModel,
  TeamModel,
  ToolModel,
} from "@/models";
import {
  assignToolToAgent,
  type PrefetchedMcpServer,
  type ToolAssignmentError,
  validateAssignment,
} from "@/services/agent-tool-assignment";
import type { InternalMcpCatalog, Tool, ToolOwnerContext } from "@/types";
import {
  AgentToolAssignmentBodySchema,
  AgentToolFilterSchema,
  AgentToolSortBy,
  ApiError,
  AssignedToolSchema,
  BulkAgentToolAssignmentSchema,
  BulkAgentToolRemovalSchema,
  constructResponseSchema,
  createSortingQuerySchema,
  DeleteObjectResponseSchema,
  MAX_BULK_AGENT_TOOL_ENTRIES,
  SelectAgentToolSchema,
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
        organizationId,
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
        credentialResolutionMode:
          credentialResolutionMode ??
          (await inferEnterpriseManagedCredentialMode({
            toolId,
            resolveAtCallTime,
          })),
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
          assignments: z
            .array(BulkAgentToolAssignmentSchema)
            .max(MAX_BULK_AGENT_TOOL_ENTRIES),
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

      const { existingAgentIds, ownerContextsByAgentId } =
        await assertCanModifyAgents({
          request,
          agentIds: [...new Set(assignments.map((a) => a.agentId))],
        });

      const { validated, failed } = await prepareToolAssignments({
        assignments,
        existingAgentIds,
        ownerContextsByAgentId,
      });
      const { succeeded, duplicates } = await writeToolAssignments({
        validated,
        organizationId: request.organizationId,
      });

      // Clear chat MCP client cache for all affected agents
      const affectedAgentIds = new Set([
        ...succeeded.map((s) => s.agentId),
        ...duplicates.map((d) => d.agentId),
      ]);
      for (const agentId of affectedAgentIds) {
        clearChatMcpClient(agentId);
      }

      // Fork a config version once per agent whose tool surface actually
      // changed. This bulk path uses AgentToolModel directly (not the
      // assignToolToAgent service), so it forks here rather than inheriting the
      // service's fork; duplicates changed nothing and are skipped.
      await AgentVersionModel.forkAgentsBestEffort(
        succeeded.map((s) => s.agentId),
      );

      return reply.send({ succeeded, failed, duplicates });
    },
  );

  fastify.post(
    "/api/agents/tools/bulk-update",
    {
      schema: {
        operationId: RouteId.BulkUpdateAgentTools,
        description:
          "Apply a batch of tool assignments and removals across agents in one request. Intended for editors that save a whole tool selection at once: the batch produces a single config version per affected agent instead of one per tool. If the same agent/tool pair appears in both lists, the assignment wins and the removal is ignored. A pair repeated within a list is written once but reported once per occurrence. Agents the caller cannot modify are reported two different ways: an agent that belongs to another organization or no longer exists is reported per entry in `failed`, and the rest of the batch still applies; an agent in the caller's own organization whose agent type the caller lacks `update` on rejects the entire request with 403 and applies nothing.",
        tags: ["Agent Tools"],
        body: z
          .object({
            assignments: z
              .array(BulkAgentToolAssignmentSchema)
              .max(MAX_BULK_AGENT_TOOL_ENTRIES)
              .default([]),
            removals: z
              .array(BulkAgentToolRemovalSchema)
              .max(MAX_BULK_AGENT_TOOL_ENTRIES)
              .default([]),
          })
          // The per-array caps above would let one body carry twice the ceiling.
          .refine(
            (body) =>
              body.assignments.length + body.removals.length <=
              MAX_BULK_AGENT_TOOL_ENTRIES,
            {
              message: `A bulk update accepts at most ${MAX_BULK_AGENT_TOOL_ENTRIES} entries across both lists`,
            },
          ),
        response: constructResponseSchema(
          z.object({
            succeeded: z.array(
              z.object({ agentId: z.string(), toolId: z.string() }),
            ),
            failed: z.array(
              z.object({
                agentId: z.string(),
                toolId: z.string(),
                error: z.string(),
              }),
            ),
            duplicates: z.array(
              z.object({ agentId: z.string(), toolId: z.string() }),
            ),
            removed: z.array(
              z.object({ agentId: z.string(), toolId: z.string() }),
            ),
            notAssigned: z.array(
              z.object({ agentId: z.string(), toolId: z.string() }),
            ),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { assignments, removals } = request.body;

      const { existingAgentIds, ownerContextsByAgentId } =
        await assertCanModifyAgents({
          request,
          agentIds: [
            ...new Set([
              ...assignments.map((a) => a.agentId),
              ...removals.map((r) => r.agentId),
            ]),
          ],
        });

      // A batch has no single resource id, and the audit registry only sees
      // route params — never the body — so this route registers without a
      // `fetchById` and supplies both snapshot sides itself. Handler-set
      // `auditBefore` bypasses the hook's sanitizer, which is safe here:
      // assignments carry ids and a credential MODE, never a credential.
      request.auditBefore =
        await buildBulkToolUpdateAuditSnapshot(existingAgentIds);

      // Validate before opening the transaction: validation only reads the
      // prefetched maps, never the `agent_tools` rows the removals touch, so
      // its verdict does not depend on running before or after them.
      const { validated, failed } = await prepareToolAssignments({
        assignments,
        existingAgentIds,
        ownerContextsByAgentId,
      });

      // Deduped per agent: a pair repeated in the body deletes one row, so
      // reporting it once per occurrence would claim more removals than
      // happened.
      const removalToolIdsByAgent = new Map<string, Set<string>>();
      // A pair the body both assigns and removes is contradictory input. The
      // assignment wins and the removal is dropped, rather than deleting the row
      // and re-inserting it: the end state is identical either way, but dropping
      // it keeps the row's identity and `createdAt`, and stops one pair from
      // being reported in both `removed` and `succeeded` — two outcomes a client
      // reconciling against the response cannot both act on. Built from the
      // requested assignments, not `validated`: a pair whose assignment failed
      // must not have its row deleted by the removal it was paired with.
      const assignedPairs = new Set(
        assignments.map((a) => `${a.agentId}:${a.toolId}`),
      );

      for (const removal of removals) {
        // An agent that is absent here does not exist, belongs to another
        // tenant, or is outside the caller's scope — nothing about the request
        // was applied, so this is a failure, not the benign `notAssigned` a
        // client is told to ignore. Same id and message the assignment side
        // produces, so both halves of one request report it identically.
        // Stays outside the transaction below: it rejects the request as
        // written, and is not state a rollback could undo.
        if (!existingAgentIds.has(removal.agentId)) {
          failed.push({
            agentId: removal.agentId,
            toolId: removal.toolId,
            error: `Agent with ID ${removal.agentId} not found`,
          });
          continue;
        }
        if (assignedPairs.has(`${removal.agentId}:${removal.toolId}`)) {
          continue;
        }
        const toolIds =
          removalToolIdsByAgent.get(removal.agentId) ?? new Set<string>();
        toolIds.add(removal.toolId);
        removalToolIdsByAgent.set(removal.agentId, toolIds);
      }

      // One transaction so the writes are all-or-nothing. Without it a throw in
      // the assignment write leaves the removals committed but unforked: the
      // agent has silently lost tools and no config version records the state to
      // restore from. The version fork below is deliberately outside — it is
      // best-effort and runs after the commit, so "committed" here means the
      // rows are final, not that a version already records them.
      const { succeeded, duplicates, removed, notAssigned } =
        await db.transaction(async (tx) => {
          // Built inside the callback and returned, so a rollback cannot leave
          // behind a report of removals that were undone.
          const removed: { agentId: string; toolId: string }[] = [];
          const notAssigned: { agentId: string; toolId: string }[] = [];

          // Removals run before assignments so a tool being re-pinned to a
          // different credential in the same save cannot have its fresh
          // assignment deleted by a stale removal.
          //
          // Sorted so the removal phase visits agents in the same order in every
          // request — that is all the sort buys. Removals and assignments are
          // separate phases whose locks are not ordered against each other, and
          // one `DELETE ... IN (...)` locks its rows in plan order rather than
          // in the order the list names them. Two saves that mirror each other's
          // add/remove sets on one agent can therefore still deadlock; Postgres
          // aborts one with 40P01 and that save rolls back.
          //
          // Byte order, not locale collation: agent ids are UUIDs, and a
          // locale-sensitive comparator would make this order depend on the
          // process's resolved ICU locale.
          for (const [agentId, toolIdSet] of [...removalToolIdsByAgent].sort(
            ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
          )) {
            const toolIds = [...toolIdSet];
            const deletedToolIds = new Set(
              await AgentToolModel.bulkDelete(agentId, toolIds, tx),
            );
            for (const toolId of toolIds) {
              // `notAssigned` means the row was already gone — a concurrent
              // edit, or a client working from a stale view. It is the
              // removal-side twin of `duplicates`, NOT a failure, and clients
              // must not treat it as one.
              if (deletedToolIds.has(toolId)) {
                removed.push({ agentId, toolId });
              } else {
                notAssigned.push({ agentId, toolId });
              }
            }
          }

          const written = await writeToolAssignments({
            validated,
            organizationId: request.organizationId,
            tx,
          });

          return { ...written, removed, notAssigned };
        });

      request.auditAfter =
        await buildBulkToolUpdateAuditSnapshot(existingAgentIds);

      for (const agentId of new Set([
        ...succeeded.map((s) => s.agentId),
        ...duplicates.map((d) => d.agentId),
        ...removed.map((r) => r.agentId),
      ])) {
        clearChatMcpClient(agentId);
      }

      // One config version per agent whose tool surface actually changed. The
      // input is the UNION of assigned and removed agents: keying it off
      // `succeeded` alone (as the bulk-assign path does, where it is complete)
      // would silently record no version at all for a removals-only save.
      await AgentVersionModel.forkAgentsBestEffort([
        ...succeeded.map((s) => s.agentId),
        ...removed.map((r) => r.agentId),
      ]);

      return reply.send({
        succeeded,
        failed,
        duplicates,
        removed,
        notAssigned,
      });
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
                      "allow_when_context_is_sensitive",
                      "block_when_context_is_sensitive",
                      "require_approval",
                      "block_always",
                    ]),
                    trustedDataAction: z.enum([
                      "mark_as_safe",
                      "mark_as_sensitive",
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

      const success = await AgentToolModel.delete({ agentId, toolId });

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
        response: constructResponseSchema(z.array(AssignedToolSchema)),
      },
    },
    async ({ params: { agentId }, user, organizationId }, reply) => {
      // Fetch the resource first so we can enforce type- and scope-aware access.
      const agent = await AgentModel.findById(agentId, user.id, true);
      if (!agent) {
        throw new ApiError(404, `Agent with ID ${agentId} not found`);
      }

      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });

      try {
        checker.require(agent.agentType, "read");
      } catch {
        throw new ApiError(404, "Agent not found");
      }

      if (!checker.isAdmin(agent.agentType)) {
        const filteredAgent = await AgentModel.findById(
          agentId,
          user.id,
          false,
        );
        if (!filteredAgent) {
          throw new ApiError(404, "Agent not found");
        }
      }

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

      // Credential-resolution / mcp-server changes are part of the tool snapshot.
      await AgentVersionModel.forkIfChangedBestEffort(agentTool.agentId);

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
        throw new ApiError(
          403,
          "You don't have permission to view agents. This requires read access to at least one agent type (agents, MCP gateways, or LLM proxies).",
        );
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
  code: ToolAssignmentError["code"],
): 400 | 403 | 404 {
  if (code === "not_found") return 404;
  if (code === "forbidden") return 403;
  return 400;
}

export default agentToolRoutes;

function normalizeBulkAssignmentCredentialResolutionMode(params: {
  assignment: z.infer<typeof BulkAgentToolAssignmentSchema>;
  toolsMap: Map<string, Tool>;
  catalogItemsMap: Map<string, InternalMcpCatalog>;
}): z.infer<typeof BulkAgentToolAssignmentSchema> {
  const { assignment, toolsMap, catalogItemsMap } = params;
  if (assignment.credentialResolutionMode || !assignment.resolveAtCallTime) {
    return assignment;
  }

  const tool = toolsMap.get(assignment.toolId);
  const catalogItem = tool?.catalogId
    ? catalogItemsMap.get(tool.catalogId)
    : null;

  if (!catalogItem?.enterpriseManagedConfig) {
    return assignment;
  }

  return {
    ...assignment,
    credentialResolutionMode: "enterprise_managed",
  };
}

/**
 * Per-agent assignment snapshot for the bulk-update audit record, used for both
 * the before and after side.
 *
 * The registry's generic `fetchById` cannot express this: a batch has no single
 * resource id, and the snapshot has to be derived from the request body, which
 * `fetchById` never sees (it receives route params only). Without this, the
 * route would fall back to an org-wide assignment COUNT — which says nothing
 * about which agent got which tool, and which a concurrent write by another
 * admin would corrupt.
 *
 * Entries are sorted so two reads of an unchanged config produce an identical
 * snapshot and the audit diff stays empty; row order from the DB is
 * unspecified.
 */
async function buildBulkToolUpdateAuditSnapshot(
  agentIds: Iterable<string>,
): Promise<Record<string, unknown>> {
  const sortedAgentIds = [...agentIds].sort();
  const assignmentsByAgent =
    await AgentToolModel.findAssignmentsByAgents(sortedAgentIds);
  return {
    agents: Object.fromEntries(
      sortedAgentIds.map((agentId) => [
        agentId,
        (assignmentsByAgent.get(agentId) ?? []).sort((a, b) =>
          a.toolId < b.toolId ? -1 : a.toolId > b.toolId ? 1 : 0,
        ),
      ]),
    ),
  };
}

/**
 * Resolve the agents a bulk body names, dropping any the caller may not modify,
 * and return the ids that survived.
 *
 * The organization is a tenant fence, and it is load-bearing: agent ids arrive
 * straight from the request body, and the scope checks below cannot catch a
 * foreign-org agent on their own, because `requireAgentModifyPermission`
 * short-circuits for an admin and "admin" means admin of the CALLER's org.
 * Fencing here drops foreign agents from the map, so they become
 * indistinguishable from ids that do not exist.
 */
async function assertCanModifyAgents(params: {
  request: { user: { id: string }; organizationId: string };
  agentIds: string[];
}): Promise<{
  existingAgentIds: Set<string>;
  /**
   * The same rows, reshaped for assignment validation. Returned rather than
   * re-derived because the permission check already read every field
   * `ToolOwnerContext` needs; without this, validating a statically-bound
   * assignment re-reads its agent — once per assignment, not once per agent.
   */
  ownerContextsByAgentId: Map<string, ToolOwnerContext>;
}> {
  const { request, agentIds } = params;

  const [agentsForPermCheck, checker] = await Promise.all([
    AgentModel.findByIdsForPermissionCheck(agentIds, request.organizationId),
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

  return {
    existingAgentIds: new Set(agentsForPermCheck.keys()),
    ownerContextsByAgentId: new Map(
      [...agentsForPermCheck].map(([agentId, agent]) => [
        agentId,
        {
          // The caller's org is the right value here only because the lookup
          // above was fenced on it — every row in the map is in this tenant.
          organizationId: request.organizationId,
          scope: agent.scope,
          authorId: agent.authorId,
          teamIds: agent.teamIds,
        },
      ]),
    ),
  };
}

/**
 * Batch-load everything assignment validation needs and split the request into
 * assignments that may be written and those that cannot.
 *
 * Performs no writes, and reads nothing from `agent_tools` — only agents,
 * tools, catalogs, and MCP servers. That is what lets the bulk-update route run
 * this before it deletes anything: the verdict cannot change based on whether
 * the removals in the same request have been applied yet.
 */
async function prepareToolAssignments(params: {
  assignments: z.infer<typeof BulkAgentToolAssignmentSchema>[];
  existingAgentIds: Set<string>;
  ownerContextsByAgentId: Map<string, ToolOwnerContext>;
}): Promise<{
  validated: z.infer<typeof BulkAgentToolAssignmentSchema>[];
  failed: { agentId: string; toolId: string; error: string }[];
}> {
  const { assignments, existingAgentIds, ownerContextsByAgentId } = params;

  const uniqueToolIds = [...new Set(assignments.map((a) => a.toolId))];
  const tools = await ToolModel.getByIds(uniqueToolIds);
  const toolsMap = new Map(tools.map((tool) => [tool.id, tool]));

  const uniqueCatalogIds = [
    ...new Set(
      tools.filter((t) => t.catalogId).map((t) => t.catalogId as string),
    ),
  ];
  const catalogItemsMap =
    uniqueCatalogIds.length > 0
      ? await InternalMcpCatalogModel.getByIds(uniqueCatalogIds)
      : new Map<string, InternalMcpCatalog>();

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

  const preFetchedData = {
    existingAgentIds,
    ownerContextsByAgentId,
    toolsMap,
    catalogItemsMap,
    mcpServersBasicMap,
  };

  const validated: typeof assignments = [];
  const failed: { agentId: string; toolId: string; error: string }[] = [];

  for (const assignment of assignments) {
    const normalizedAssignment =
      normalizeBulkAssignmentCredentialResolutionMode({
        assignment,
        toolsMap,
        catalogItemsMap,
      });
    const validationError = await validateAssignment({
      agentId: normalizedAssignment.agentId,
      toolId: normalizedAssignment.toolId,
      mcpServerId: normalizedAssignment.mcpServerId,
      preFetchedData,
      resolveAtCallTime: normalizedAssignment.resolveAtCallTime,
      credentialResolutionMode: normalizedAssignment.credentialResolutionMode,
    });
    if (validationError) {
      failed.push({
        agentId: assignment.agentId,
        toolId: assignment.toolId,
        error: validationError.error.message,
      });
    } else {
      validated.push(normalizedAssignment);
    }
  }

  return { validated, failed };
}

/**
 * Write validated assignments, splitting the model's per-row status into the
 * two buckets the API reports: anything that changed a row is `succeeded`,
 * anything that already matched is `duplicates` (which changed nothing and so
 * must not trigger a config-version fork).
 */
async function writeToolAssignments(params: {
  validated: z.infer<typeof BulkAgentToolAssignmentSchema>[];
  organizationId: string;
  tx?: Transaction;
}): Promise<{
  succeeded: { agentId: string; toolId: string }[];
  duplicates: { agentId: string; toolId: string }[];
}> {
  const bulkResults = await AgentToolModel.bulkCreateOrUpdateCredentials(
    params.validated,
    params.organizationId,
    params.tx,
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

  return { succeeded, duplicates };
}

async function inferEnterpriseManagedCredentialMode(params: {
  toolId: string;
  resolveAtCallTime?: boolean;
}): Promise<"enterprise_managed" | undefined> {
  if (!params.resolveAtCallTime) {
    return undefined;
  }

  const tool = await ToolModel.findById(params.toolId);
  if (!tool?.catalogId) {
    return undefined;
  }

  const catalogItem = await InternalMcpCatalogModel.findById(tool.catalogId, {
    expandSecrets: false,
  });

  return catalogItem?.enterpriseManagedConfig
    ? ("enterprise_managed" as const)
    : undefined;
}
