import {
  type AgentType,
  BUILT_IN_AGENT_IDS,
  createPaginatedResponseSchema,
  getResourceForAgentType,
  isModelSelectionComplete,
  PaginationQuerySchema,
  parseLabelsParam,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getAgentTypePermissionChecker,
  hasAnyAgentTypeReadPermission,
  isGlobalAdmin,
  requireAgentModifyPermission,
  userHasPermission,
} from "@/auth";
// Imported from the module rather than the `@/auth` barrel on purpose: route
// tests mock `@/auth` wholesale to open up permissions, and these are
// validation rules (team existence, org ownership, the ≥1-team invariant) that
// must keep running in those tests rather than silently becoming no-ops.
import {
  type AgentTypePermissionChecker,
  assertAgentTeams,
} from "@/auth/agent-type-permissions";
import { getSkillPermissionChecker } from "@/auth/skill-permissions";
import config from "@/config";
import { knowledgeSourceAccessControlService } from "@/knowledge-base";
import {
  AgentLabelModel,
  AgentModel,
  AgentTeamModel,
  AgentVersionModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  MemberModel,
  ProjectModel,
  TeamModel,
} from "@/models";
import { initializeObservabilityMetrics } from "@/observability";
import { getAgentCredentialReadiness } from "@/services/agent-credential-readiness";
import { serializeAgentForExport } from "@/services/agent-export";
import { importAgentFromPayload } from "@/services/agent-import";
import { agentKnowledgeSourceExclusionsService } from "@/services/agent-knowledge-source-exclusions";
import { agentSkillAssignmentService } from "@/services/agent-skill-assignment";
import { agentSubagentExclusionsService } from "@/services/agent-subagent-exclusions";
import { assertNoStaticPinsBrokenByTargetChange } from "@/services/agent-tool-assignment";
import { agentToolExclusionsService } from "@/services/agent-tool-exclusions";
import { restoreAgentVersion } from "@/services/agent-version-restore";
import { findVisibleChatAgent } from "@/services/chat-agent-visibility";
import {
  assertCanAssignEnvironment,
  resolveDefaultEnvironmentForNewResource,
} from "@/services/environments/environment";
import {
  type Agent,
  type AgentBackgroundExecution,
  AgentCredentialReadinessSchema,
  AgentExportPayloadSchema,
  AgentKnowledgeSourceExclusionsSchema,
  type AgentScope,
  AgentScopeFilterSchema,
  AgentScopeSchema,
  AgentSkillAssignmentsResponseSchema,
  AgentSkillAssignmentsSchema,
  AgentSkillExclusionsResponseSchema,
  AgentSkillExclusionsSchema,
  AgentSubagentExclusionsSchema,
  AgentToolExclusionsSchema,
  ApiError,
  BuiltInAgentConfigSchema,
  CloneAgentBodySchema,
  constructResponseSchema,
  createSortingQuerySchema,
  DeleteObjectResponseSchema,
  ImportAgentResponseSchema,
  InsertAgentSchema,
  SelectAgentSchema,
  UpdateAgentSchemaBase,
  UuidIdSchema,
} from "@/types";
import {
  AgentVersionMetadataSchema,
  RestoreAgentVersionBodySchema,
  SelectAgentVersionSchema,
} from "@/types/agent-version";
import { isForeignKeyConstraintError } from "@/utils/db";
import {
  BulkDeleteBodySchema,
  BulkIdsSchema,
  BulkOutcomeSchema,
  runBulk,
} from "./bulk-route";

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
              .enum(["profile", "mcp_gateway", "agent"])
              .optional()
              .describe(
                "Filter by agent type. 'profile' = external API gateway profiles, 'mcp_gateway' = MCP gateway, 'agent' = internal agents with prompts.",
              ),
            agentTypes: z
              .preprocess(
                (val) => (typeof val === "string" ? val.split(",") : val),
                z.array(z.enum(["profile", "mcp_gateway", "agent"])),
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
            status: z
              .enum(["active", "deleted"])
              .optional()
              .describe(
                "Filter by lifecycle status. Deleted rows require delete permission.",
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
              "lastUsedAt",
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
          status,
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

      const permittedTypes = getPermittedAgentTypesForList({
        checker,
        effectiveTypes,
        status,
      });

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
            agentType: agentTypes || permittedTypes ? undefined : agentType,
            agentTypes: permittedTypes ?? agentTypes,
            scope,
            teamIds,
            // authorIds and excludeAuthorIds are admin-only
            authorIds: isAdmin ? authorIds : undefined,
            excludeAuthorIds: isAdmin ? excludeAuthorIds : undefined,
            excludeOtherPersonalAgents: isAdmin
              ? excludeOtherPersonalAgents
              : undefined,
            labels: parseLabelsParam(labels),
            status,
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
            .enum(["profile", "mcp_gateway", "agent"])
            .optional()
            .describe(
              "Filter by agent type. 'profile' = external API gateway profiles, 'mcp_gateway' = MCP gateway, 'agent' = internal agents with prompts.",
            ),
          agentTypes: z
            .preprocess(
              (val) => (typeof val === "string" ? val.split(",") : val),
              z.array(z.enum(["profile", "mcp_gateway", "agent"])),
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
          includeAdvisor: z
            .preprocess((val) => val === "true" || val === true, z.boolean())
            .optional()
            .describe(
              "Keep the advisor in the results while built-in agents are excluded. For pickers that choose a subagent to delegate to.",
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
          status: z
            .enum(["active", "deleted"])
            .optional()
            .describe(
              "Filter by lifecycle status. Deleted rows require delete permission.",
            ),
          includeTools: z
            .preprocess((val) => val !== "false" && val !== false, z.boolean())
            .optional()
            .describe(
              "Attach each agent's assigned tools. Defaults to true. Pass false from callers that only need the roster itself — the tool refs carry every tool's name and description, which on an organization of any size is the great majority of this response's bytes. Agents come back with an empty `tools` array when it is off, meaning 'not requested' rather than 'none assigned'.",
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
          includeAdvisor,
          scope,
          excludeOtherPersonalAgents,
          status,
          includeTools,
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

      const permittedTypes = getPermittedAgentTypesForList({
        checker,
        effectiveTypes,
        status,
      });

      // Check admin for the specific type(s) being queried, or any type if unfiltered
      const isAdmin = effectiveTypes
        ? effectiveTypes.length === 1
          ? checker.isAdmin(effectiveTypes[0])
          : checker.hasAnyAdminPermission()
        : checker.hasAnyAdminPermission();

      return reply.send(
        await AgentModel.findAll(user.id, isAdmin, {
          // agentTypes takes precedence over agentType
          agentType: agentTypes || permittedTypes ? undefined : agentType,
          agentTypes: permittedTypes ?? agentTypes,
          excludeBuiltIn,
          includeAdvisor,
          scope:
            scope && scope !== "built_in" ? (scope as AgentScope) : undefined,
          excludeOtherPersonalAgents: isAdmin
            ? excludeOtherPersonalAgents
            : undefined,
          status,
          includeTools,
        }),
      );
    },
  );

  fastify.get(
    "/api/agents/credential-readiness",
    {
      schema: {
        operationId: RouteId.GetAgentCredentialReadiness,
        description:
          "For each internal agent that enforces a missing-credential behavior, the MCP servers the calling user has no usable connection to",
        tags: ["Agents"],
        response: constructResponseSchema(
          z.array(AgentCredentialReadinessSchema),
        ),
      },
    },
    async ({ user, organizationId }, reply) => {
      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });

      const agents = await AgentModel.findAll(
        user.id,
        checker.isAdmin("agent"),
        {
          agentTypes: ["agent"],
          excludeBuiltIn: true,
          onlyEnforcingMissingCredentials: true,
        },
      );

      return reply.send(
        await getAgentCredentialReadiness({ agents, userId: user.id }),
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

  fastify.post(
    "/api/agents/import",
    {
      // Limit import payloads to 1 MiB — agent configs are small JSON files;
      // rejecting oversized payloads protects against accidental or malicious abuse.
      bodyLimit: 1 * 1024 * 1024,
      schema: {
        operationId: RouteId.ImportAgent,
        description:
          "Import an agent from a portable JSON payload. Creates a new agent with all resolvable associations and returns soft warnings for any references that could not be found.",
        tags: ["Agents"],
        body: AgentExportPayloadSchema,
        response: constructResponseSchema(ImportAgentResponseSchema),
      },
    },
    async ({ body, user, organizationId }, reply) => {
      // Only agent type is supported for import
      if (body.agent.agentType !== "agent") {
        throw new ApiError(
          400,
          "Only internal agents can be imported. MCP gateways and LLM proxies are not supported.",
        );
      }

      // Check create permission for agent type
      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      checker.require("agent", "create");

      const result = await importAgentFromPayload(
        body,
        user.id,
        organizationId,
      );

      return reply.send(result);
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
      if (agentType === "llm_proxy") {
        throw new ApiError(400, LLM_PROXY_MANAGED_MESSAGE);
      }

      // Single DB query for all permission checks on this agent type
      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      checker.require(agentType, "create");
      requireBackgroundExecutionPermission({
        agentType,
        backgroundExecution: body.backgroundExecution,
        isAdmin: checker.isAdmin(agentType),
      });

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

      // A model and its API key are a pair: persist both or neither.
      if (
        !isModelSelectionComplete({
          modelId: body.modelId,
          apiKeyId: body.llmApiKeyId,
        })
      ) {
        throw new ApiError(
          400,
          "An agent's model and API key must be set together",
        );
      }

      const environmentId = await resolveNewAgentEnvironmentId({
        userId: user.id,
        organizationId,
        agentType,
        requested: body.environmentId,
      });
      // Always assert on create: a null environment still lands on the org
      // default, which may itself be restricted (mirrors the MCP-catalog path).
      await assertEnvironmentAssignable({
        userId: user.id,
        organizationId,
        environmentId,
        agentType,
      });

      // A team-scoped agent with no teams is accessible to nobody (not even its
      // author), so reject it, and reject teams outside this organization.
      // Applies to admins too — they can otherwise reach this via the API/UI
      // (issue #6624).
      await assertAgentTeams({
        scope: body.scope ?? "personal",
        teamIds: body.teams,
        organizationId,
      });

      // Omit teams if scope is not 'team' — scope takes precedence.
      // `builtInAgentConfig` is server-owned: only the seeder sets it, and it
      // is a trust attribute (the advisor discriminator drives the delegation
      // environment exception), so a client-supplied value is dropped here.
      const createData = {
        ...body,
        environmentId,
        builtInAgentConfig: null,
        ...(body.scope !== "team" && { teams: [] }),
      };
      // Whether a new record starts out able to consult the Advisor is decided
      // here, not by a follow-up write from the client: that second write
      // forks another version and silently never happens for roles without
      // `agent:read`.
      const defaultExcludedSubagentIds =
        await agentSubagentExclusionsService.getCreationDefaultExclusions({
          organizationId: createData.organizationId ?? organizationId,
          agentType,
          accessAllSubagents: createData.accessAllSubagents === true,
        });

      const agent = await AgentModel.create(createData, user.id, {
        defaultExcludedSubagentIds,
      });
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
      const agent = await requireReadableAgent({
        id,
        userId: user.id,
        organizationId,
      });
      return reply.send(agent);
    },
  );

  fastify.get(
    "/api/agents/:id/versions",
    {
      schema: {
        operationId: RouteId.GetAgentVersions,
        description:
          "List an agent's config version history, newest first, as " +
          "metadata only (no snapshot). Retention keeps the last 100 " +
          "versions, so the oldest listed version may be greater than 1.",
        tags: ["Agents"],
        params: z.object({ id: UuidIdSchema }),
        querystring: PaginationQuerySchema,
        response: constructResponseSchema(
          createPaginatedResponseSchema(AgentVersionMetadataSchema),
        ),
      },
    },
    async ({ params: { id }, query, user, organizationId }, reply) => {
      await requireReadableAgent({ id, userId: user.id, organizationId });
      return reply.send(
        await AgentVersionModel.listForAgent({
          agentId: id,
          organizationId,
          pagination: query,
        }),
      );
    },
  );

  fastify.get(
    "/api/agents/:id/versions/:version",
    {
      schema: {
        operationId: RouteId.GetAgentVersion,
        description:
          "Get one immutable agent config version (full snapshot; key " +
          "material is never captured). Versions dropped by retention are " +
          "404.",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
          // capped at int4 max so impossible versions 400 instead of
          // reaching Postgres as an out-of-range bind
          version: z.coerce.number().int().positive().max(2_147_483_647),
        }),
        response: constructResponseSchema(SelectAgentVersionSchema),
      },
    },
    async ({ params: { id, version }, user, organizationId }, reply) => {
      await requireReadableAgent({ id, userId: user.id, organizationId });
      const row = await AgentVersionModel.findByAgentAndVersion({
        agentId: id,
        version,
        organizationId,
      });
      if (!row) {
        throw new ApiError(404, `Agent has no version ${version}`);
      }
      return reply.send(row);
    },
  );

  fastify.post(
    "/api/agents/:id/versions/:version/restore",
    {
      schema: {
        operationId: RouteId.RestoreAgentVersion,
        description:
          "Restore an agent's config to an earlier version by replaying its " +
          "snapshot forward as a new head version — history is never " +
          "rewritten. All-or-nothing: the restore is validated in full before " +
          "anything is written, and a version referencing something that no " +
          "longer exists or is out of the caller's reach (a deleted tool, key " +
          "or knowledge source) is rejected with 400 rather than partially " +
          "applied. Only differences from the agent's live config are written, " +
          "so restoring the current configuration is a no-op. Retrying is " +
          "safe: the source version is immutable, and the pre-restore config " +
          "is forked as a version before anything is written.",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
          // capped at int4 max so impossible versions 400 instead of
          // reaching Postgres as an out-of-range bind
          version: z.coerce.number().int().positive().max(2_147_483_647),
        }),
        // Nullish so a bare POST without a payload keeps working (an empty
        // body arrives as null)
        body: RestoreAgentVersionBodySchema.nullish(),
        response: constructResponseSchema(SelectAgentSchema),
      },
    },
    async ({ params: { id, version }, body, user, organizationId }, reply) => {
      // Fetch agent to determine its type for permission check
      const existingAgent = await AgentModel.findById(id, user.id, true);
      if (!existingAgent) {
        throw new ApiError(404, "Agent not found");
      }

      // Defense-in-depth: never allow cross-organization access, even for
      // admins. AgentModel.findById is not org-scoped.
      if (existingAgent.organizationId !== organizationId) {
        throw new ApiError(404, "Agent not found");
      }

      if (existingAgent.agentType === "llm_proxy") {
        throw new ApiError(400, LLM_PROXY_MANAGED_MESSAGE);
      }

      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });

      // Restoring is an update in permission terms
      // (return 404 to avoid leaking existence)
      try {
        checker.require(existingAgent.agentType, "update");
      } catch {
        throw new ApiError(404, "Agent not found");
      }
      // Enforce scope-based modify permissions like UpdateAgent does
      const userTeamIds = !checker.isAdmin(existingAgent.agentType)
        ? await TeamModel.getUserTeamIds(user.id)
        : [];
      requireAgentModifyPermission({
        checker,
        agentType: existingAgent.agentType,
        agentScope: existingAgent.scope,
        agentAuthorId: existingAgent.authorId,
        agentTeamIds: existingAgent.teams.map((t) => t.id),
        userTeamIds,
        userId: user.id,
      });

      // Built-in agents restrict which fields an update may touch; a snapshot
      // replay would bypass that allowlist.
      if (existingAgent.builtInAgentConfig) {
        throw new ApiError(403, "Built-in agents cannot be restored");
      }

      return reply.send(
        await restoreAgentVersion({
          agentId: id,
          version,
          baseVersion: body?.baseVersion,
          userId: user.id,
          organizationId,
        }),
      );
    },
  );

  fastify.post(
    "/api/agents/:id/clone",
    {
      schema: {
        operationId: RouteId.CloneAgent,
        description:
          "Clone an agent and all its associations. Optionally override the clone's visibility (scope/teams); by default the source's visibility is copied.",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        // Nullish so pre-existing clients that POST without a payload keep
        // working (an empty body arrives as null)
        body: CloneAgentBodySchema.nullish(),
        response: constructResponseSchema(SelectAgentSchema),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
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

      if (sourceAgent.agentType === "llm_proxy") {
        throw new ApiError(400, LLM_PROXY_MANAGED_MESSAGE);
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

      // The clone is a new agent, so an explicitly requested visibility is
      // validated like agent creation (mirrors POST /api/agents).
      const targetScope = body?.scope ?? sourceAgent.scope;
      const requestedTeams = body?.teams ?? [];

      // A team-scoped clone must land on ≥1 team (issue #6624) and may only
      // target teams in this organization. Effective teams default to the
      // source's when the caller omits them, matching AgentModel.cloneAgent.
      // Applies to admins too.
      await assertAgentTeams({
        scope: targetScope,
        teamIds: body?.teams ?? sourceAgent.teams.map((t) => t.id),
        organizationId,
      });

      if (!checker.isAdmin(sourceAgent.agentType)) {
        if (targetScope === "org") {
          throw new ApiError(403, "Only admins can create org-scoped agents");
        }
        if (targetScope === "team" || requestedTeams.length > 0) {
          if (!checker.isTeamAdmin(sourceAgent.agentType)) {
            throw new ApiError(
              403,
              "You need team-admin permission to create team-scoped agents",
            );
          }

          // team-admin can only assign teams they are a member of
          const userTeamIdSet = new Set(userTeamIds);
          const invalidTeams = requestedTeams.filter(
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

      // Validate knowledgeBaseIds if provided
      if ((sourceAgent.knowledgeBaseIds?.length ?? 0) > 0) {
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
        scope: body?.scope,
        teams: body?.teams,
      });

      return reply.send(clonedAgent);
    },
  );

  fastify.get(
    "/api/agents/:id/export",
    {
      schema: {
        operationId: RouteId.ExportAgent,
        description:
          "Export an agent configuration as a portable JSON payload for cross-instance transfer",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(AgentExportPayloadSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      // Fetch agent with admin=true first to check type, then enforce type-specific RBAC
      const agent = await AgentModel.findById(id, user.id, true);

      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      // Defense-in-depth: never allow cross-organization exports, even for admins.
      // Permissions are scoped to the current organizationId.
      if (agent.organizationId !== organizationId) {
        throw new ApiError(404, "Agent not found");
      }

      // Only internal agents can be exported
      if (agent.agentType !== "agent") {
        throw new ApiError(
          400,
          "Only internal agents can be exported. MCP gateways and LLM proxies are not supported.",
        );
      }

      // Built-in agents cannot be exported
      if (agent.builtInAgentConfig) {
        throw new ApiError(
          400,
          "Built-in agents cannot be exported. They contain internal configuration that is not portable.",
        );
      }

      // Check read permission (return 404 to avoid leaking existence)
      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });

      try {
        checker.require(agent.agentType, "read");
      } catch {
        throw new ApiError(404, "Agent not found");
      }

      // Non-admin: re-fetch with team filtering to enforce access control
      if (!checker.isAdmin(agent.agentType)) {
        const filteredAgent = await AgentModel.findById(id, user.id, false);
        if (!filteredAgent) {
          throw new ApiError(404, "Agent not found");
        }
        return reply.send(await serializeAgentForExport(filteredAgent));
      }

      return reply.send(await serializeAgentForExport(agent));
    },
  );

  fastify.get(
    "/api/agents/:id/tool-exclusions",
    {
      schema: {
        operationId: RouteId.GetAgentToolExclusions,
        description:
          "Get the agent's Auto-tool-mode exclusions: MCP catalogs and individual tools removed from its tool surface while 'access all tools' is on",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(AgentToolExclusionsSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      // Fetch agent first to determine its type, then enforce type-specific RBAC
      const agent = await AgentModel.findById(id, user.id, true);
      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      // Defense-in-depth: never allow cross-organization access, even for
      // admins. AgentModel.findById is not org-scoped.
      if (agent.organizationId !== organizationId) {
        throw new ApiError(404, "Agent not found");
      }

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

      // Non-admin: enforce scope/team-based visibility like GetAgent does
      if (!checker.isAdmin(agent.agentType)) {
        const filteredAgent = await AgentModel.findById(id, user.id, false);
        if (!filteredAgent) {
          throw new ApiError(404, "Agent not found");
        }
      }

      return reply.send(await agentToolExclusionsService.getExclusions(id));
    },
  );

  fastify.put(
    "/api/agents/:id/tool-exclusions",
    {
      schema: {
        operationId: RouteId.UpdateAgentToolExclusions,
        description:
          "Replace the agent's Auto-tool-mode exclusions (full replace of the excluded tool set)",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: AgentToolExclusionsSchema,
        response: constructResponseSchema(AgentToolExclusionsSchema),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      // Fetch agent to determine its type for permission check
      const agent = await AgentModel.findById(id, user.id, true);
      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      // Defense-in-depth: never allow cross-organization access, even for
      // admins. AgentModel.findById is not org-scoped.
      if (agent.organizationId !== organizationId) {
        throw new ApiError(404, "Agent not found");
      }

      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });

      // Editing exclusions requires the same permission as agent update
      // (return 404 to avoid leaking existence)
      try {
        checker.require(agent.agentType, "update");
      } catch {
        throw new ApiError(404, "Agent not found");
      }

      // Enforce scope-based modify permissions like UpdateAgent does
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

      return reply.send(
        await agentToolExclusionsService.replaceExclusions({
          agentId: id,
          organizationId,
          excludedToolIds: body.excludedToolIds,
        }),
      );
    },
  );

  fastify.get(
    "/api/agents/:id/subagent-exclusions",
    {
      schema: {
        operationId: RouteId.GetAgentSubagentExclusions,
        description:
          "Get the agent's Auto-subagent-mode exclusions: delegation target agents removed from its Auto delegation surface while 'access all subagents' is on",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(AgentSubagentExclusionsSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      // Fetch agent first to determine its type, then enforce type-specific RBAC
      const agent = await AgentModel.findById(id, user.id, true);
      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      // Defense-in-depth: never allow cross-organization access, even for
      // admins. AgentModel.findById is not org-scoped.
      if (agent.organizationId !== organizationId) {
        throw new ApiError(404, "Agent not found");
      }

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

      // Non-admin: enforce scope/team-based visibility like GetAgent does
      if (!checker.isAdmin(agent.agentType)) {
        const filteredAgent = await AgentModel.findById(id, user.id, false);
        if (!filteredAgent) {
          throw new ApiError(404, "Agent not found");
        }
      }

      return reply.send(await agentSubagentExclusionsService.getExclusions(id));
    },
  );

  fastify.put(
    "/api/agents/:id/subagent-exclusions",
    {
      schema: {
        operationId: RouteId.UpdateAgentSubagentExclusions,
        description:
          "Replace the agent's Auto-subagent-mode exclusions (full replace of the excluded delegation-target set)",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: AgentSubagentExclusionsSchema,
        response: constructResponseSchema(AgentSubagentExclusionsSchema),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      // Fetch agent to determine its type for permission check
      const agent = await AgentModel.findById(id, user.id, true);
      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      // Defense-in-depth: never allow cross-organization access, even for
      // admins. AgentModel.findById is not org-scoped.
      if (agent.organizationId !== organizationId) {
        throw new ApiError(404, "Agent not found");
      }

      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });

      // Editing exclusions requires the same permission as agent update
      // (return 404 to avoid leaking existence)
      try {
        checker.require(agent.agentType, "update");
      } catch {
        throw new ApiError(404, "Agent not found");
      }

      // Enforce scope-based modify permissions like UpdateAgent does
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

      return reply.send(
        await agentSubagentExclusionsService.replaceExclusions({
          agentId: id,
          organizationId,
          excludedSubagentIds: body.excludedSubagentIds,
        }),
      );
    },
  );

  fastify.get(
    "/api/agents/:id/knowledge-source-exclusions",
    {
      schema: {
        operationId: RouteId.GetAgentKnowledgeSourceExclusions,
        description:
          "Get the agent's Auto-mode knowledge-source exclusions: knowledge connectors removed from the surface its knowledge queries span while 'access all tools' is on",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(AgentKnowledgeSourceExclusionsSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      await requireAgentReadAccess({ id, user, organizationId });
      return reply.send(
        await agentKnowledgeSourceExclusionsService.getExclusions(id),
      );
    },
  );

  fastify.put(
    "/api/agents/:id/knowledge-source-exclusions",
    {
      schema: {
        operationId: RouteId.UpdateAgentKnowledgeSourceExclusions,
        description:
          "Replace the agent's Auto-mode knowledge-source exclusions (full replace of the excluded knowledge-connector set)",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: AgentKnowledgeSourceExclusionsSchema,
        response: constructResponseSchema(AgentKnowledgeSourceExclusionsSchema),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      await requireAgentUpdateAccess({ id, user, organizationId });
      return reply.send(
        await agentKnowledgeSourceExclusionsService.replaceExclusions({
          agentId: id,
          organizationId,
          excludedConnectorIds: body.excludedConnectorIds,
        }),
      );
    },
  );

  fastify.get(
    "/api/agents/:id/skills",
    {
      schema: {
        operationId: RouteId.GetAgentSkills,
        description:
          "Get the skills this gateway publishes over MCP: the explicitly assigned set, plus whether Auto mode ('access all skills') is on",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(AgentSkillAssignmentsResponseSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      await requireAgentReadAccess({ id, user, organizationId });
      return reply.send(await agentSkillAssignmentService.getAssignments(id));
    },
  );

  fastify.put(
    "/api/agents/:id/skills",
    {
      schema: {
        operationId: RouteId.UpdateAgentSkills,
        description:
          "Replace the skills this gateway publishes over MCP (full replace of the assigned set) and set Auto mode",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: AgentSkillAssignmentsSchema,
        response: constructResponseSchema(AgentSkillAssignmentsResponseSchema),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      const { isSkillAdmin } = await requireAgentSkillWriteAccess({
        id,
        user,
        organizationId,
      });
      return reply.send(
        await agentSkillAssignmentService.replaceAssignments({
          agentId: id,
          organizationId,
          userId: user.id,
          isSkillAdmin,
          assignments: body,
        }),
      );
    },
  );

  fastify.get(
    "/api/agents/:id/skill-exclusions",
    {
      schema: {
        operationId: RouteId.GetAgentSkillExclusions,
        description:
          "Get the agent's Auto-skill-mode exclusions: skills removed from its published skill surface while 'access all skills' is on",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(AgentSkillExclusionsResponseSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      await requireAgentReadAccess({ id, user, organizationId });
      return reply.send(await agentSkillAssignmentService.getExclusions(id));
    },
  );

  fastify.put(
    "/api/agents/:id/skill-exclusions",
    {
      schema: {
        operationId: RouteId.UpdateAgentSkillExclusions,
        description:
          "Replace the agent's Auto-skill-mode exclusions (full replace of the excluded skill set)",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: AgentSkillExclusionsSchema,
        response: constructResponseSchema(AgentSkillExclusionsResponseSchema),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      const { isSkillAdmin } = await requireAgentSkillWriteAccess({
        id,
        user,
        organizationId,
      });
      return reply.send(
        await agentSkillAssignmentService.replaceExclusions({
          agentId: id,
          organizationId,
          userId: user.id,
          isSkillAdmin,
          excludedSkillIds: body.excludedSkillIds,
        }),
      );
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
      // Fetch agent to determine its type for permission check. The
      // organization fence comes first so a foreign row — the LLM Proxy
      // included — reads as plain 404 rather than classifying itself.
      const existingAgent = await AgentModel.findById(id, user.id, true);
      if (!existingAgent || existingAgent.organizationId !== organizationId) {
        throw new ApiError(404, "Agent not found");
      }

      if (
        existingAgent.agentType === "llm_proxy" ||
        body.agentType === "llm_proxy"
      ) {
        throw new ApiError(400, LLM_PROXY_MANAGED_MESSAGE);
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
      requireBackgroundExecutionPermission({
        agentType: existingAgent.agentType,
        backgroundExecution: body.backgroundExecution,
        isAdmin: checker.isAdmin(existingAgent.agentType),
      });

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

      // A team-scoped agent must keep ≥1 team (issue #6624) and may only be
      // assigned teams in this organization. Evaluate the merged result — the
      // team-admin path above may have rewritten body.teams — so this catches
      // switching to team scope with none, or clearing the teams of an already
      // team-scoped agent. Applies to admins too.
      await assertAgentTeams({
        scope: body.scope ?? existingAgent.scope,
        teamIds: body.teams ?? existingAgent.teams.map((t) => t.id),
        organizationId,
      });

      // Validate knowledgeBaseIds if provided
      if (body.knowledgeBaseIds && body.knowledgeBaseIds.length > 0) {
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

        // The advisor is one org-wide row every environment's agents reach
        // through delegation. A team scope would hide it from everyone
        // outside that team's delegation surface, and an environment would
        // re-fence it — reject a narrowing change rather than silently scoping
        // a shared resource. A no-op that restates org scope or an empty team
        // list is allowed (the dialog may resend it).
        if (
          existingAgent.builtInAgentConfig.name === BUILT_IN_AGENT_IDS.ADVISOR
        ) {
          const narrowsScope = body.scope !== undefined && body.scope !== "org";
          const assignsTeams =
            body.teams !== undefined && body.teams.length > 0;
          if (narrowsScope || assignsTeams) {
            throw new ApiError(
              400,
              "The Advisor is shared by the whole organization and cannot be scoped to teams",
            );
          }
          if (body.environmentId !== undefined && body.environmentId !== null) {
            throw new ApiError(
              400,
              "The Advisor is org-wide and cannot be assigned to an environment",
            );
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
          ...(body.modelId !== undefined && { modelId: body.modelId }),
          ...(body.scope !== undefined && { scope: body.scope }),
          ...(body.teams !== undefined && { teams: body.teams }),
        };
      } else {
        // Omit teams if scope is not 'team' — scope takes precedence.
        // `builtInAgentConfig` is server-owned and a trust attribute (drives
        // the advisor delegation exception), so a client cannot promote an
        // ordinary agent into a built-in by supplying it on update.
        const { builtInAgentConfig: _ignoredBuiltIn, ...bodyWithoutBuiltIn } =
          body;
        updateData = {
          ...bodyWithoutBuiltIn,
          ...((body.scope ?? existingAgent.scope) !== "team" &&
            body.teams !== undefined && { teams: [] }),
        };
      }

      // A model and its API key are a pair: persist both or neither. Validate
      // the merged result, but only when this update touches either field — an
      // unrelated edit must not be blocked by a pre-existing half pair.
      if (body.modelId !== undefined || body.llmApiKeyId !== undefined) {
        const mergedModelId =
          body.modelId !== undefined ? body.modelId : existingAgent.modelId;
        const mergedApiKeyId =
          body.llmApiKeyId !== undefined
            ? body.llmApiKeyId
            : existingAgent.llmApiKeyId;
        if (
          !isModelSelectionComplete({
            modelId: mergedModelId,
            apiKeyId: mergedApiKeyId,
          })
        ) {
          throw new ApiError(
            400,
            "An agent's model and API key must be set together",
          );
        }
      }

      if (body.environmentId !== undefined) {
        await assertEnvironmentAssignable({
          userId: user.id,
          organizationId,
          environmentId: body.environmentId,
          agentType: existingAgent.agentType,
        });
      }

      // A static tool assignment pins one installed connection, and a
      // team-scoped connection is only assignable while the agent shares that
      // team. Moving the agent's scope or teams therefore silently strips the
      // right to a credential its tools still point at — the runtime trusts
      // the persisted mcpServerId — so re-check the pins it already holds and
      // refuse before anything is written (AgentModel.update syncs teams).
      // The evaluated scope/team set is the merged one: the team-admin branch
      // above may have rewritten body.teams to preserve teams it cannot touch.
      // Known gap: an assignment or team-membership change racing this check
      // can still land a stale pin; validating at call time is the follow-up.
      const currentTeamIds = existingAgent.teams.map((team) => team.id);
      await assertNoStaticPinsBrokenByTargetChange({
        agentId: id,
        currentTarget: {
          organizationId: existingAgent.organizationId,
          scope: existingAgent.scope,
          authorId: existingAgent.authorId,
          teamIds: currentTeamIds,
        },
        nextTarget: {
          organizationId: existingAgent.organizationId,
          scope: body.scope ?? existingAgent.scope,
          authorId: existingAgent.authorId,
          teamIds: body.teams ?? currentTeamIds,
        },
      });

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

  fastify.patch(
    "/api/agents/bulk",
    {
      schema: {
        operationId: RouteId.BulkUpdateAgents,
        description:
          "Update several agents in one request. Today the only editable " +
          "surface is visibility — `scope` with the `teams` it belongs to or " +
          "the `users` it is shared with — and every agent in the batch is " +
          "moved to the same one. The target is validated once for the whole " +
          "request (a 400 or 403 changes nothing); per-agent problems, such " +
          "as an id the caller cannot see or modify, are reported in `failed` " +
          "and leave the rest of the batch applied. An agent already in the " +
          "requested state is reported as succeeded without being rewritten.",
        tags: ["Agents"],
        body: z
          .object({
            ids: BulkIdsSchema,
            scope: AgentScopeSchema.describe(
              "The visibility every agent in the batch moves to.",
            ),
            teams: z
              .array(z.string())
              .optional()
              .describe("Only meaningful for `scope = team`; required there."),
            users: z
              .array(z.string())
              .optional()
              .describe(
                "People to share with. Only meaningful for " +
                  "`scope = personal`; ignored otherwise. Unlike the " +
                  "single-agent update, omitting it revokes existing grants " +
                  "rather than keeping them: this sets one visibility across " +
                  "the whole selection, so a per-agent grant list would " +
                  "survive as a difference the request just asked to remove.",
              ),
          })
          .describe(
            "Ids plus the fields to change. Shaped so further bulk-editable " +
              "fields can be added here rather than as another endpoint.",
          ),
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      const { organizationId, user, body } = request;
      const { scope } = body;
      // Mirrors the single-agent update: teams only bind a team-scoped agent
      // and grants only a personal one, so the other set is cleared rather
      // than left stranded on an agent whose visibility now says otherwise.
      const teams = scope === "team" ? [...new Set(body.teams ?? [])] : [];
      const users = scope === "personal" ? [...new Set(body.users ?? [])] : [];

      // Request-level: the target is the same for every agent, so an unusable
      // one is a bad request rather than N identical per-agent failures.
      await assertAgentTeams({ scope, teamIds: teams, organizationId });

      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);
      const userTeamIdSet = new Set(userTeamIds);

      const outcome = await runBulk({
        ids: body.ids,
        logLabel: "agents bulk update",
        notFoundMessage: "Agent not found",
        unexpectedMessage: "Could not update this agent",
        load: async (ids) =>
          new Map(
            (
              await AgentModel.findForBulk({ organizationId, agentIds: ids })
            ).map((agent) => [agent.id, agent]),
          ),
        describe: (agent) => agent.name,
        authorize: (agent) => {
          if (agent.agentType === "llm_proxy") {
            throw new ApiError(400, LLM_PROXY_MANAGED_MESSAGE);
          }
          // A type the caller cannot update is answered as "not found", as the
          // single-agent update does, so a batch never confirms an agent
          // exists that the caller was not allowed to see.
          try {
            checker.require(agent.agentType, "update");
          } catch {
            throw new ApiError(404, "Agent not found");
          }

          const isAdmin = checker.isAdmin(agent.agentType);
          requireAgentModifyPermission({
            checker,
            agentType: agent.agentType,
            agentScope: agent.scope,
            agentAuthorId: agent.authorId,
            agentTeamIds: agent.teamIds,
            userTeamIds: isAdmin ? [] : userTeamIds,
            userId: user.id,
          });

          // Admin-ness is per agent type, so these cannot be hoisted to a
          // request-level 403 the way the team validation above can.
          if (!isAdmin) {
            if (scope === "org") {
              throw new ApiError(403, "Only admins can set scope to org");
            }
            if (
              (scope === "team" || teams.length > 0) &&
              !checker.isTeamAdmin(agent.agentType)
            ) {
              throw new ApiError(
                403,
                "You need team-admin permission to set scope to team",
              );
            }
            // A team-admin may only place an agent on teams they belong to.
            // The single-agent update silently preserves teams they do not
            // control; a batch cannot, because it sets one team list across
            // the selection — so an unassignable team is refused outright
            // rather than quietly producing a different result per agent.
            const unassignable = teams.filter((id) => !userTeamIdSet.has(id));
            if (checker.isTeamAdmin(agent.agentType) && unassignable.length) {
              throw new ApiError(
                403,
                "You can only assign teams you are a member of",
              );
            }
          }

          if (scope === "personal" && agent.scope !== "personal") {
            throw new ApiError(400, "Shared agents cannot be made personal");
          }
          // A personal agent IS its author, and `author_id` is nullable —
          // built-ins are seeded without one, and deleting a user leaves their
          // shared agents authorless. Making one of those personal would
          // strand it, reachable by nobody, which is exactly what selecting a
          // whole page and choosing "personal" would otherwise do.
          if (scope === "personal" && agent.authorId === null) {
            throw new ApiError(
              400,
              "This agent has no author, so it cannot be made personal. " +
                "Share it with named people instead, or leave it team- or " +
                "organization-scoped.",
            );
          }
        },
        applyEach: async (agent, id) => {
          const unchanged =
            agent.scope === scope && sameIdSet(agent.teamIds, teams);
          if (unchanged && scope !== "personal") return;
          await AgentModel.update(id, { scope, teams, users });
        },
        audit: {
          target: request,
          snapshot: async (ids) => ({
            agents: await AgentModel.findVisibilityForBulkAudit({
              organizationId,
              agentIds: ids,
            }),
          }),
        },
      });

      return reply.send(outcome);
    },
  );

  fastify.delete(
    "/api/agents/bulk",
    {
      schema: {
        operationId: RouteId.BulkDeleteAgents,
        description:
          "Soft-delete several agents in one request. Each id is authorized " +
          "exactly as the single-agent delete authorizes its own, so an id " +
          "the caller cannot see or modify — and a built-in agent or personal " +
          "MCP gateway, which are never deletable — is reported in `failed` " +
          "while the rest of the batch still applies. Deleted agents can be " +
          "restored from the trash. Members who chose one as their personal " +
          "default, and projects pinning it, are unpinned, as they are on the " +
          "single-agent delete.",
        tags: ["Agents"],
        body: BulkDeleteBodySchema,
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      const { organizationId, user, body } = request;

      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);

      const outcome = await runBulk({
        ids: body.ids,
        logLabel: "agents bulk delete",
        notFoundMessage: "Agent not found",
        unexpectedMessage: "Could not delete this agent",
        load: async (ids) =>
          new Map(
            (
              await AgentModel.findForBulk({ organizationId, agentIds: ids })
            ).map((agent) => [agent.id, agent]),
          ),
        describe: (agent) => agent.name,
        authorize: (agent) => {
          if (agent.agentType === "llm_proxy") {
            throw new ApiError(400, LLM_PROXY_MANAGED_MESSAGE);
          }
          try {
            checker.require(agent.agentType, "delete");
          } catch {
            throw new ApiError(404, "Agent not found");
          }
          requireAgentModifyPermission({
            checker,
            agentType: agent.agentType,
            agentScope: agent.scope,
            agentAuthorId: agent.authorId,
            agentTeamIds: agent.teamIds,
            userTeamIds: checker.isAdmin(agent.agentType) ? [] : userTeamIds,
            userId: user.id,
          });
          if (agent.isBuiltIn) {
            throw new ApiError(403, "Built-in agents cannot be deleted");
          }
          if (agent.isPersonalGateway) {
            throw new ApiError(403, "Personal MCP gateways cannot be deleted.");
          }
        },
        applyEach: async (_agent, id) => {
          const deleted = await AgentModel.delete(id);
          if (!deleted) {
            throw new ApiError(404, "Agent not found");
          }
          await MemberModel.clearDefaultAgent(id);
          await ProjectModel.clearDefaultAgent(id);
        },
        audit: {
          target: request,
          snapshot: async (ids) => ({
            agents: await AgentModel.findVisibilityForBulkAudit({
              organizationId,
              agentIds: ids,
            }),
          }),
        },
      });

      return reply.send(outcome);
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
      // Fetch agent to determine its type for permission check. The
      // organization fence comes first so a foreign row — the LLM Proxy
      // included — reads as plain 404 rather than classifying itself.
      const agent = await AgentModel.findById(id, user.id, true);
      if (!agent || agent.organizationId !== organizationId) {
        throw new ApiError(404, "Agent not found");
      }

      if (agent.agentType === "llm_proxy") {
        throw new ApiError(400, LLM_PROXY_MANAGED_MESSAGE);
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

      // Prevent deletion of a user's personal MCP gateway
      if (agent.isPersonalGateway) {
        throw new ApiError(403, "Personal MCP gateways cannot be deleted.");
      }

      const success = await AgentModel.delete(id);

      if (!success) {
        throw new ApiError(404, "Agent not found");
      }

      // Members who chose this agent as their personal default, and projects
      // pinning it, are shown "no default" from here on, so clear both sets of
      // rows to match. Left set, restoring the agent would silently re-pin
      // owners who were last told the pin was gone. Neither blocks the delete:
      // every chat still resolves (organization default, then the member's own
      // personal chat agent), which is what made the old "Cannot delete a
      // default agent" refusal a dead end.
      await MemberModel.clearDefaultAgent(id);
      await ProjectModel.clearDefaultAgent(id);

      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/agents/:id/restore",
    {
      schema: {
        operationId: RouteId.RestoreAgent,
        description: "Restore a soft-deleted agent",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectAgentSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      const agent = await AgentModel.findDeletedByIdForOrganization(
        id,
        organizationId,
      );
      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      if (agent.agentType === "llm_proxy") {
        throw new ApiError(400, LLM_PROXY_MANAGED_MESSAGE);
      }

      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      try {
        checker.require(agent.agentType, "delete");
      } catch {
        throw new ApiError(404, "Agent not found");
      }

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

      const conflictMessage = await AgentModel.getRestoreConflictMessage(agent);
      if (conflictMessage) {
        throw new ApiError(409, conflictMessage);
      }

      const success = await AgentModel.restore(id);
      if (!success) {
        throw new ApiError(404, "Agent not found");
      }

      const restored = await AgentModel.findById(id, user.id, true);
      if (!restored) {
        throw new ApiError(404, "Agent not found");
      }

      return reply.send(restored);
    },
  );

  fastify.delete(
    "/api/agents/:id/permanent",
    {
      schema: {
        operationId: RouteId.PermanentlyDeleteAgent,
        description:
          "Permanently destroy a soft-deleted agent. Global admins only — an " +
          "`agent:delete` or `agent:admin` grant reaches the trash, not past " +
          "it. Irreversible, with no grace period: the agent's configuration " +
          "and scheduled runs are destroyed, and it is cleared from the " +
          "organization, /connection, and member defaults. Its history " +
          "survives, detached — conversations and LLM usage rows are kept and " +
          "simply stop pointing at it. 404 if there is no soft-deleted agent " +
          "with that id in the org, which is also the answer when the agent " +
          "is still live or the caller is not a global admin. Restore wins a " +
          "race.",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      // Checked before the agent is looked up at all: a non-admin gets the same
      // 404 whatever the id, so the endpoint never confirms an agent exists.
      // The purge itself re-checks id, org, and soft-deleted state under a row
      // lock; the read below only classifies the target's type.
      if (!(await isGlobalAdmin(user.id, organizationId))) {
        throw new ApiError(404, "Agent not found");
      }

      const deletedAgent = await AgentModel.findDeletedByIdForOrganization(
        id,
        organizationId,
      );
      if (deletedAgent?.agentType === "llm_proxy") {
        throw new ApiError(400, LLM_PROXY_MANAGED_MESSAGE);
      }

      const purged = await AgentModel.purge(id, organizationId);
      if (!purged) {
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
        throw new ApiError(403, AGENT_READ_FORBIDDEN_MESSAGE);
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
        throw new ApiError(403, AGENT_READ_FORBIDDEN_MESSAGE);
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

  fastify.put(
    "/api/members/default-agent",
    {
      schema: {
        operationId: RouteId.UpdateMemberDefaultAgent,
        description:
          "Set or clear the current user's default agent. Any chat agent the " +
          "caller can see may be pinned — their own, a team's, or an " +
          "organization-wide one — and it is preselected for their new chats " +
          "ahead of the organization default. Null clears it, so the " +
          "organization default applies. Nothing else writes this: a member " +
          "who never pinned one has no personal default, and the " +
          "organization default reaches them.",
        tags: ["Members"],
        body: z.object({ defaultAgentId: z.string().uuid().nullable() }),
        response: constructResponseSchema(
          z.object({ defaultAgentId: z.string().uuid().nullable() }),
        ),
      },
    },
    async ({ body, user, organizationId }, reply) => {
      if (body.defaultAgentId) {
        // Pinnable == visible: whatever the caller could start a chat with.
        // A miss is one undifferentiated 404, so the route leaks nothing
        // about agents they cannot see.
        const agent = await findVisibleChatAgent({
          agentId: body.defaultAgentId,
          userId: user.id,
          organizationId,
        });
        if (!agent) {
          throw new ApiError(404, "Agent not found");
        }
      }

      await MemberModel.setDefaultAgent(
        user.id,
        organizationId,
        body.defaultAgentId,
      );
      return reply.send({ defaultAgentId: body.defaultAgentId });
    },
  );

  fastify.get(
    "/api/members/default-model",
    {
      schema: {
        operationId: RouteId.GetMemberDefaultModel,
        description: "Get the current user's default model and API key",
        tags: ["Members"],
        response: constructResponseSchema(
          z.object({
            modelId: z.string().uuid().nullable(),
            chatApiKeyId: z.string().uuid().nullable(),
          }),
        ),
      },
    },
    async ({ user, organizationId }, reply) => {
      const selection = await MemberModel.getDefaultModelSelection(
        user.id,
        organizationId,
      );
      return reply.send(selection);
    },
  );

  fastify.put(
    "/api/members/default-model",
    {
      schema: {
        operationId: RouteId.UpdateMemberDefaultModel,
        description: "Set the current user's default model and API key",
        tags: ["Members"],
        body: z.object({
          modelId: z.string().uuid().nullable(),
          chatApiKeyId: z.string().uuid().nullable(),
        }),
        response: constructResponseSchema(
          z.object({
            modelId: z.string().uuid().nullable(),
            chatApiKeyId: z.string().uuid().nullable(),
          }),
        ),
      },
    },
    async ({ body, user, organizationId }, reply) => {
      // The default model and its API key are a pair: persist both or neither.
      if (
        !isModelSelectionComplete({
          modelId: body.modelId,
          apiKeyId: body.chatApiKeyId,
        })
      ) {
        throw new ApiError(
          400,
          "The default model and API key must be set together",
        );
      }

      try {
        await MemberModel.setDefaultModelSelection({
          userId: user.id,
          organizationId,
          modelId: body.modelId,
          apiKeyId: body.chatApiKeyId,
        });
      } catch (error) {
        // The referenced model or API key can be deleted between the client
        // loading its options and saving the selection.
        if (isForeignKeyConstraintError(error)) {
          throw new ApiError(
            400,
            "The selected model or API key no longer exists",
          );
        }
        throw error;
      }

      return reply.send({
        modelId: body.modelId,
        chatApiKeyId: body.chatApiKeyId,
      });
    },
  );
};

export default agentRoutes;

/**
 * Resolve a live agent and enforce the full read-access path shared by
 * GetAgent and the version-history routes: org scoping, per-type RBAC, and —
 * for non-admins — team-filtered visibility. Every failure is a 404 so
 * existence is never leaked. Version reads don't filter soft-deletes
 * themselves, so resolving the live agent here (findById excludes deleted
 * rows) is what keeps a deleted agent's history unreachable.
 */
async function requireReadableAgent(params: {
  id: string;
  userId: string;
  organizationId: string;
}): Promise<Agent> {
  // admin lookup first to learn the type, then enforce type-specific RBAC
  const agent = await AgentModel.findById(params.id, params.userId, true);
  if (!agent || agent.organizationId !== params.organizationId) {
    throw new ApiError(404, "Agent not found");
  }

  if (agent.agentType === "llm_proxy") {
    throw new ApiError(400, LLM_PROXY_MANAGED_MESSAGE);
  }

  const checker = await getAgentTypePermissionChecker({
    userId: params.userId,
    organizationId: params.organizationId,
  });
  try {
    checker.require(agent.agentType, "read");
  } catch {
    throw new ApiError(404, "Agent not found");
  }

  if (!checker.isAdmin(agent.agentType)) {
    // Team/author visibility, mirroring GetAgent's non-admin filter. The
    // already-fetched agent serves as the access context — no re-fetch.
    const hasAccess = await AgentTeamModel.userHasAgentAccess(
      params.userId,
      params.id,
      false,
      agent,
    );
    if (!hasAccess) {
      throw new ApiError(404, "Agent not found");
    }
  }

  return agent;
}

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

function getPermittedAgentTypesForList(params: {
  checker: AgentTypePermissionChecker;
  effectiveTypes: AgentType[] | undefined;
  status: "active" | "deleted" | undefined;
}): AgentType[] | undefined {
  const action = params.status === "deleted" ? "delete" : "read";

  if (params.effectiveTypes) {
    for (const type of params.effectiveTypes) {
      params.checker.require(type, action);
    }
    return undefined;
  }

  const permittedTypes = params.checker.getAgentTypesWithPermission(action);
  if (permittedTypes.length === 0) {
    throw new ApiError(403, AGENT_READ_FORBIDDEN_MESSAGE);
  }

  return permittedTypes;
}

/**
 * Binding an agent to a restricted environment routes its code sandbox to that
 * environment's isolated runtime, so it is gated by the resource-specific
 * deploy-to-restricted permission for the agent's type — agent or
 * mcpGateway. Throws 403/404 if the caller may not assign the environment.
 */
async function assertEnvironmentAssignable(params: {
  userId: string;
  organizationId: string;
  environmentId: string | null;
  agentType: AgentType;
}): Promise<void> {
  const { userId, organizationId, environmentId, agentType } = params;
  const hasResourceDeploy = await userHasPermission(
    userId,
    organizationId,
    getResourceForAgentType(agentType),
    "deploy-to-restricted",
  );
  await assertCanAssignEnvironment({
    environmentId,
    organizationId,
    canDeployToRestricted: hasResourceDeploy,
  });
}

/**
 * The environment a new agent binds to. An explicit value in the body wins
 * (including a deliberate null, which means the default environment); omitting
 * the field defers to the org's configured landing environment for the agent's
 * type — agents and MCP gateways are configured separately.
 */
async function resolveNewAgentEnvironmentId(params: {
  userId: string;
  organizationId: string;
  agentType: AgentType;
  requested: string | null | undefined;
}): Promise<string | null> {
  const { userId, organizationId, agentType, requested } = params;
  if (requested !== undefined) return requested;
  const resource = getResourceForAgentType(agentType);
  // Fail closed: the create route rejects llm_proxy before this runs, and the
  // LLM Proxy has no landing-environment default of its own.
  if (resource === "llmProxy") {
    throw new ApiError(400, LLM_PROXY_MANAGED_MESSAGE);
  }
  return resolveDefaultEnvironmentForNewResource({
    organizationId,
    resource,
    canDeployToRestricted: await userHasPermission(
      userId,
      organizationId,
      resource,
      "deploy-to-restricted",
    ),
  });
}

/**
 * Read-permission gate for the skill-publication endpoints.
 *
 * Same shape as the tool/subagent exclusion endpoints: every failure is a 404
 * rather than a 403, so the response cannot be used to discover which agents
 * exist.
 */
async function requireAgentReadAccess(params: {
  id: string;
  user: { id: string };
  organizationId: string;
}): Promise<void> {
  const { id, user, organizationId } = params;

  const agent = await AgentModel.findById(id, user.id, true);
  // findById is not org-scoped, so check it here: an admin must not reach
  // across organizations either.
  if (!agent || agent.organizationId !== organizationId) {
    throw new ApiError(404, "Agent not found");
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
    const filteredAgent = await AgentModel.findById(id, user.id, false);
    if (!filteredAgent) {
      throw new ApiError(404, "Agent not found");
    }
  }
}

/**
 * Update-permission gate for the per-agent sub-resource endpoints (exclusion
 * sets and the like): editing a facet of an agent's config requires the same
 * permission as editing the agent itself, so this runs the identical
 * agent-type and scope checks `PUT /api/agents/:id` runs. Resource-specific
 * capability checks (see `requireAgentSkillWriteAccess`) layer on top.
 */
async function requireAgentUpdateAccess(params: {
  id: string;
  user: { id: string };
  organizationId: string;
}): Promise<void> {
  const { id, user, organizationId } = params;

  const agent = await AgentModel.findById(id, user.id, true);
  if (!agent || agent.organizationId !== organizationId) {
    throw new ApiError(404, "Agent not found");
  }

  const checker = await getAgentTypePermissionChecker({
    userId: user.id,
    organizationId,
  });

  try {
    checker.require(agent.agentType, "update");
  } catch {
    throw new ApiError(404, "Agent not found");
  }

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
}

/**
 * Write-permission gate for the skill-publication endpoints, in two halves.
 *
 * The gateway half is here: editing what a gateway publishes requires the same
 * permission as editing the gateway itself, so this runs the identical
 * agent-type and scope checks `PUT /api/agents/:id` runs.
 *
 * The skill half is in two places, and both are load-bearing. The capability
 * — `skill:read` — is enforced by the middleware from
 * `requiredEndpointPermissionsMap`, so a role deliberately stripped of the
 * skill resource cannot reach these routes at all. The per-skill visibility
 * check is enforced by the assignment service, and this function only resolves
 * the `skill:admin` flag that service needs: publishing or excluding a skill
 * requires that the caller could already read it (org-scoped, their own,
 * shared with them, or assigned to one of their teams), with `skill:admin`
 * bypassing that as it does everywhere else. Neither half implies the other —
 * visibility is a property of the skill, the capability a property of the
 * role. Gateway permission alone is not sufficient for either, because
 * `mcpGateway:update` is a default member permission and publishing hands the
 * skill's full body to every holder of the gateway's token.
 *
 * Deliberately NOT re-checked at serve time: revoking a user's team membership
 * (or narrowing a skill's team assignments) does not retroactively un-publish
 * what they already published. The audit log records who published what; a
 * serve-time re-check is a known follow-up.
 */
async function requireAgentSkillWriteAccess(params: {
  id: string;
  user: { id: string };
  organizationId: string;
}): Promise<{ isSkillAdmin: boolean }> {
  const { user, organizationId } = params;

  await requireAgentUpdateAccess(params);

  // Skill permissions are a separate resource from the agent's: an mcpGateway
  // admin is not automatically a skill admin.
  const skillChecker = await getSkillPermissionChecker({
    userId: user.id,
    organizationId,
  });
  return { isSkillAdmin: skillChecker.isAdmin };
}

/**
 * 403 copy for endpoints that only need read access to at least one agent
 * type; the caller has none.
 */
const AGENT_READ_FORBIDDEN_MESSAGE =
  "You don't have permission to view agents. This requires read access to at least one agent type (agents or MCP gateways).";

/**
 * 400 copy for generic agent CRUD aimed at an `llm_proxy` row. The LLM Proxy
 * has its own management surface, so these routes never touch it.
 */
const LLM_PROXY_MANAGED_MESSAGE =
  "The LLM Proxy is managed on the LLM Proxy page.";

function requireBackgroundExecutionPermission(params: {
  agentType: AgentType;
  backgroundExecution?: AgentBackgroundExecution | null;
  isAdmin: boolean;
}): void {
  if (params.backgroundExecution == null) return;
  if (!config.agentBackgroundExecution.enabled) {
    throw new ApiError(400, "Background execution is not enabled");
  }
  if (params.agentType !== "agent") {
    throw new ApiError(
      400,
      "Background execution can only be configured for Agents",
    );
  }
  if (params.backgroundExecution.privileged && !params.isAdmin) {
    throw new ApiError(
      403,
      "Only Agent administrators can enable a privileged background deployment",
    );
  }
  if (
    params.backgroundExecution.privileged &&
    !config.agentBackgroundExecution.allowPrivileged
  ) {
    throw new ApiError(
      403,
      "Privileged background deployments are disabled by the deployment operator",
    );
  }
}

/** Whether two id lists hold the same set of ids, order aside. */
function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}
