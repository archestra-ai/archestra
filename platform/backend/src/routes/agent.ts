import {
  type AgentType,
  BUILT_IN_AGENT_IDS,
  createPaginatedResponseSchema,
  getResourceForAgentType,
  isModelSelectionComplete,
  PaginationQuerySchema,
  parseLabelsParam,
  ResourcePermissionGrantSchema,
  RouteId,
  TOOL_LOAD_SKILL_SHORT_NAME,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { isArchestraToolAvailableToAgent } from "@/archestra-mcp-server/dynamic-tools";
import {
  getAgentTypePermissionChecker,
  hasAnyAgentTypeReadPermission,
  isGlobalAdmin,
  requireAgentModifyPermission,
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
import { isServiceAccountUserId } from "@/auth/utils";
import config from "@/config";
import { createPaginatedResult } from "@/database/utils/pagination";
import { knowledgeSourceAccessControlService } from "@/knowledge-base";
import {
  AgentLabelModel,
  AgentModel,
  AgentPinModel,
  AgentTeamModel,
  AgentVersionModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  MemberModel,
  OrganizationModel,
  ProjectModel,
  TeamModel,
} from "@/models";
import { initializeObservabilityMetrics } from "@/observability";
import { listPolicyIndependentAvailableAgentSkills } from "@/services/agent-activation-skill-candidates";
import { agentActivationSkillPolicyService } from "@/services/agent-activation-skill-policy";
import {
  getPaginatedAgentActivationSkills,
  projectPolicyIndependentAvailableAgentSkills,
} from "@/services/agent-activation-skills";
import { getAgentCredentialReadiness } from "@/services/agent-credential-readiness";
import { serializeAgentForExport } from "@/services/agent-export";
import { importAgentFromPayload } from "@/services/agent-import";
import { agentKnowledgeSourceExclusionsService } from "@/services/agent-knowledge-source-exclusions";
import { populateAgentListActivationSkillCounts } from "@/services/agent-list";
import { transferAgentOwnership } from "@/services/agent-ownership";
import { getResolvedAgentRuntimeModelCompatibility } from "@/services/agent-runtime/model-compatibility";
import { agentSkillAssignmentService } from "@/services/agent-skill-assignment";
import { agentSubagentExclusionsService } from "@/services/agent-subagent-exclusions";
import { agentToolExclusionsService } from "@/services/agent-tool-exclusions";
import { restoreAgentVersion } from "@/services/agent-version-restore";
import { findVisibleChatAgent } from "@/services/chat-agent-visibility";
import {
  assertCanAssignEnvironment,
  resolveDefaultEnvironmentForNewResource,
} from "@/services/environments/environment";
import { ResourcePermissions } from "@/services/resource-permissions";
import {
  type Agent,
  AgentActivationSkillPolicyResponseSchema,
  AgentCredentialReadinessSchema,
  AgentExportPayloadSchema,
  AgentKnowledgeSourceExclusionsSchema,
  AgentListItemSchema,
  type AgentRuntime,
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
  PaginatedAgentActivationSkillsResponseSchema,
  PatchAgentActivationSkillPolicySchema,
  SelectAgentSchema,
  UpdateAgentSchemaBase,
  UuidIdSchema,
} from "@/types";
import {
  AgentVersionMetadataSchema,
  RestoreAgentVersionBodySchema,
  SelectPublicAgentVersionSchema,
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
            includeActivationSkillsCount: z
              .preprocess(
                (val) => (typeof val === "string" ? val === "true" : val),
                z.boolean(),
              )
              .optional()
              .describe(
                "Include the caller-relative activation skill count used by internal-agent cards. Omitted when the caller lacks skill:read.",
              ),
            providerApiKeyId: z
              .union([z.string().uuid(), z.literal("organization-default")])
              .optional()
              .describe(
                "Filter by a configured provider key, or organization-default for agents with no pinned key or model.",
              ),
            pinned: z
              .preprocess(
                (value) =>
                  typeof value === "string" ? value === "true" : value,
                z.boolean(),
              )
              .optional()
              .describe(
                "Filter by the current user's pins. Pinned results are ordered by newest pin first; unpinned results keep the requested sort.",
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
          createPaginatedResponseSchema(AgentListItemSchema),
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
          includeActivationSkillsCount,
          providerApiKeyId,
          pinned,
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

      const result = await AgentModel.findAllPaginated(
        { limit, offset },
        { sortBy, sortDirection },
        {
          authorization: {
            organizationId,
            baseReadTypes: checker.getAgentTypesWithPermission("read"),
          },
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
          providerApiKeyId,
          pinned,
        },
        user.id,
        isAdmin,
      );
      if (includeActivationSkillsCount) {
        await populateAgentListActivationSkillCounts({
          agents: result.data,
          organizationId,
          userId: user.id,
        });
      }
      return reply.send(result);
    },
  );

  fastify.put(
    "/api/agents/:id/pin",
    {
      schema: {
        operationId: RouteId.PinAgent,
        description:
          "Pin an agent for the current user. Personal — does not affect other members. Any user who can read the agent may pin it.",
        tags: ["Agents"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      await requireReadableAgent({ id, userId: user.id, organizationId });
      await AgentPinModel.pin({ userId: user.id, agentId: id });
      return reply.send({ ok: true as const });
    },
  );

  fastify.delete(
    "/api/agents/:id/pin",
    {
      schema: {
        operationId: RouteId.UnpinAgent,
        description:
          "Remove the current user's pin on an agent. Idempotent and intentionally has no visibility check so stale pins can still be cleared.",
        tags: ["Agents"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async ({ params: { id }, user }, reply) => {
      await AgentPinModel.unpin({ userId: user.id, agentId: id });
      return reply.send({ ok: true as const });
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
          view: z
            .enum(["chat"])
            .optional()
            .describe(
              "Return the lightweight agent fields needed to initialize chat. Large embedded icons, system prompts, sharing metadata, and unrelated list hydration are omitted; fetch an individual agent before editing it.",
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
          view,
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
          authorization: {
            organizationId,
            baseReadTypes: checker.getAgentTypesWithPermission("read"),
          },
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
          view,
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
        body: InsertAgentSchema.extend({
          initialGrants: z
            .array(ResourcePermissionGrantSchema)
            .max(200)
            .optional(),
        }),
        response: constructResponseSchema(SelectAgentSchema),
      },
    },
    async ({ body: requestBody, user, organizationId }, reply) => {
      const { initialGrants, ...body } = requestBody;
      const resourceId = crypto.randomUUID();
      // Check create permission for the specific agent type
      const agentType = body.agentType ?? "mcp_gateway";
      if (agentType === "llm_proxy") {
        throw new ApiError(400, LLM_PROXY_MANAGED_MESSAGE);
      }
      if (body.activationSkillPolicy) {
        if (agentType !== "agent") {
          throw new ApiError(
            400,
            "Activation skill policies are available only for internal agents.",
          );
        }
        const skillChecker = await getSkillPermissionChecker({
          userId: user.id,
          organizationId,
        });
        if (!skillChecker.canRead) {
          throw new ApiError(403, "Skill read permission is required");
        }
      }

      // Single DB query for all permission checks on this agent type
      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      checker.require(agentType, "create");
      if (
        body.organizationId !== undefined &&
        body.organizationId !== organizationId
      ) {
        throw new ApiError(
          403,
          "Cannot create an agent in another organization",
        );
      }
      const isServiceAccount = isServiceAccountUserId(user.id);
      if (isServiceAccount && body.scope === "personal") {
        throw new ApiError(
          400,
          "Service accounts cannot create personal agents. Use org or team scope.",
        );
      }
      requireAgentRuntimePermission({
        agentType,
        runtime: body.runtime,
        isAdmin: checker.isAdmin(agentType),
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
      await assertAgentRuntimeModelCompatibility({
        runtime: body.runtime,
        agent: {
          llmApiKeyId: body.llmApiKeyId ?? null,
          modelId: body.modelId ?? null,
        },
        organizationId,
        userId: user.id,
      });

      const environmentId = await resolveNewAgentEnvironmentId({
        userId: user.id,
        organizationId,
        agentType,
        requested: body.environmentId,
      });
      // Always assert on create: a null environment still lands on the org
      // default, which may itself be restricted (mirrors the MCP-catalog path).
      await assertCanAssignEnvironment({
        userId: user.id,
        organizationId,
        environmentId,
      });
      if (body.activationSkillPolicy) {
        await agentActivationSkillPolicyService.validatePolicyForDraft({
          organizationId,
          userId: user.id,
          environmentId,
          policy: body.activationSkillPolicy,
        });
      }

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
      if (initialGrants !== undefined) {
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        await ResourcePermissions.validateInitialGrants({
          organizationId,
          userId: user.id,
          resource: agentType === "mcp_gateway" ? "mcpGateway" : "agent",
          grants: initialGrants,
          target: {
            id: resourceId,
            name: body.name,
            authorId: user.id,
            scope: body.scope ?? "personal",
            teams: body.teams.map((id) => ({ id })),
            users: [],
          },
        });
        // SPDX-SnippetEnd
      }
      const createData = {
        ...body,
        id: resourceId,
        organizationId,
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
          organizationId,
          agentType,
          accessAllSubagents: createData.accessAllSubagents === true,
        });

      const agent = await AgentModel.create(createData, user.id, {
        defaultExcludedSubagentIds,
        deferInitialVersionFork: body.activationSkillPolicy !== undefined,
        initialPermissionGrants: ResourcePermissions.grantsForCreation({
          grants: initialGrants,
          visibility: body.scope,
        }),
      });
      if (body.activationSkillPolicy) {
        try {
          await agentActivationSkillPolicyService.initializePolicy({
            agentId: agent.id,
            organizationId,
            userId: user.id,
            policy: body.activationSkillPolicy,
          });
        } catch (error) {
          // Policy initialization is the last fallible step after row creation.
          // Clean up the not-yet-returned staged agent on any failure rather
          // than leaving an orphan in the list.
          await AgentModel.hardDelete(agent.id);
          throw error;
        }
        agent.activationSkillMode = body.activationSkillPolicy.mode;
        agent.activationSkillPolicyRevision = 1;
        const fork = await AgentVersionModel.forkIfChangedBestEffort(agent.id);
        if (fork) agent.latestVersion = fork.version;
      }
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
      const result = await AgentVersionModel.listForAgent({
        agentId: id,
        organizationId,
        pagination: query,
      });
      return reply.send({
        ...result,
        data: result.data.map((version) => ({
          ...version,
          contentHash: AgentVersionModel.computePublicContentHash(
            version.contentHash,
          ),
        })),
      });
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
        response: constructResponseSchema(SelectPublicAgentVersionSchema),
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
      const { activationSkillRules, ...publicSnapshot } = row.snapshot;
      const snapshot = {
        ...publicSnapshot,
        activationSkillRuleCounts: {
          allowed: activationSkillRules.filter(
            (rule) => rule.disposition === "allow",
          ).length,
          excluded: activationSkillRules.filter(
            (rule) => rule.disposition === "exclude",
          ).length,
        },
        activationSkillRuleDigest:
          AgentVersionModel.computeActivationSkillRuleDigest(
            activationSkillRules,
          ),
      };
      return reply.send({
        ...row,
        contentHash: AgentVersionModel.computePublicContentHash(
          row.contentHash,
        ),
        snapshot,
      });
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
        checker.require(existingAgent.agentType, {
          action: "update",
          scope: existingAgent.id,
        });
      } catch {
        throw new ApiError(404, "Agent not found");
      }
      // Requires an update grant on this agent, like UpdateAgent does
      requireAgentModifyPermission({
        agentId: existingAgent.id,
        action: "update",
        checker,
        agentType: existingAgent.agentType,
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
          "Clone an agent and its associations with explicit permission grants. The creator receives full access; source sharing is not copied.",
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
        checker.require(sourceAgent.agentType, {
          action: "read",
          scope: sourceAgent.id,
        });
        checker.require(sourceAgent.agentType, "create");
      } catch {
        throw new ApiError(404, "Agent not found");
      }

      // Requires an update grant on the source agent
      requireAgentModifyPermission({
        agentId: sourceAgent.id,
        action: "update",
        checker,
        agentType: sourceAgent.agentType,
      });

      const initialGrants = body?.initialGrants ?? [];
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      await ResourcePermissions.validateInitialGrants({
        organizationId,
        userId: user.id,
        resource:
          sourceAgent.agentType === "mcp_gateway" ? "mcpGateway" : "agent",
        grants: initialGrants,
        target: {
          ...sourceAgent,
          scope: "personal",
          authorId: user.id,
          users: [],
          teams: [],
        },
      });
      // SPDX-SnippetEnd

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
        scope: "personal",
        teams: [],
        initialGrants,
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
        checker.require(agent.agentType, { action: "read", scope: agent.id });
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
        checker.require(agent.agentType, { action: "read", scope: agent.id });
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
        checker.require(agent.agentType, { action: "update", scope: agent.id });
      } catch {
        throw new ApiError(404, "Agent not found");
      }

      // Requires an update grant on this agent, like UpdateAgent does
      requireAgentModifyPermission({
        agentId: agent.id,
        action: "update",
        checker,
        agentType: agent.agentType,
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
        checker.require(agent.agentType, { action: "read", scope: agent.id });
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
        checker.require(agent.agentType, { action: "update", scope: agent.id });
      } catch {
        throw new ApiError(404, "Agent not found");
      }

      // Requires an update grant on this agent, like UpdateAgent does
      requireAgentModifyPermission({
        agentId: agent.id,
        action: "update",
        checker,
        agentType: agent.agentType,
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
    "/api/agents/activation-skills",
    {
      schema: {
        operationId: RouteId.GetAgentActivationSkills,
        description:
          "List a paginated, searchable view of effective or policy-eligible skills for an internal agent or draft",
        tags: ["Agents"],
        querystring: PaginationQuerySchema.extend({
          search: z
            .string()
            .optional()
            .describe(
              "Case-insensitive substring match on skill name, activation name, description, or provider name.",
            ),
          agentId: UuidIdSchema.optional().describe(
            "Existing internal agent to evaluate. Omit to preview a new agent.",
          ),
          environmentId: UuidIdSchema.nullable()
            .optional()
            .describe(
              "Environment preview override for a draft or pending edit. Omit to use the saved agent environment, or the Default environment for a new draft.",
            ),
          view: z
            .enum(["effective", "eligible"])
            .default("effective")
            .describe(
              "Effective applies the saved agent policy; eligible lists caller-visible choices for the policy editor.",
            ),
        }).refine(
          ({ agentId, environmentId, view }) =>
            view === "eligible" ||
            agentId === undefined ||
            environmentId === undefined,
          "Pass agentId or environmentId, not both for the effective view",
        ),
        response: constructResponseSchema(
          PaginatedAgentActivationSkillsResponseSchema,
        ),
      },
    },
    async (
      {
        query: { agentId, environmentId, limit, offset, search, view },
        user,
        organizationId,
      },
      reply,
    ) => {
      let enabled: boolean;
      let resolvedEnvironmentId: string | null;

      if (agentId) {
        const agent =
          view === "eligible"
            ? await requireAgentUpdateAccess({
                id: agentId,
                user,
                organizationId,
              })
            : await requireAgentReadAccess({
                id: agentId,
                user,
                organizationId,
              });
        if (agent.agentType !== "agent") {
          throw new ApiError(
            400,
            "Activation skills are available only for internal agents.",
          );
        }
        resolvedEnvironmentId =
          environmentId !== undefined
            ? environmentId
            : (agent.environmentId ?? null);
        if (environmentId !== undefined) {
          await assertCanAssignEnvironment({
            environmentId: resolvedEnvironmentId,
            organizationId,
            userId: user.id,
          });
        }
        enabled = await isArchestraToolAvailableToAgent({
          toolName: archestraMcpBranding.getToolName(
            TOOL_LOAD_SKILL_SHORT_NAME,
          ),
          agentId: agent.id,
          organizationId,
          userId: user.id,
        });
      } else {
        const checker = await getAgentTypePermissionChecker({
          userId: user.id,
          organizationId,
        });
        checker.require("agent", "create");
        resolvedEnvironmentId = environmentId ?? null;
        await assertCanAssignEnvironment({
          environmentId: resolvedEnvironmentId,
          organizationId,
          userId: user.id,
        });
        enabled =
          (await OrganizationModel.getById(organizationId))
            ?.skillToolsEnabled === true;
      }

      if (view === "eligible") {
        const candidates = await listPolicyIndependentAvailableAgentSkills({
          organizationId,
          userId: user.id,
          ...(agentId && environmentId === undefined
            ? { agentId }
            : { environmentId: resolvedEnvironmentId }),
        });
        const skills = projectPolicyIndependentAvailableAgentSkills(candidates);
        const normalizedSearch = search?.trim().toLowerCase();
        const filtered = normalizedSearch
          ? skills.filter((skill) =>
              [
                skill.name,
                skill.activationName,
                skill.description,
                skill.providerName,
              ].some((field) =>
                field?.toLowerCase().includes(normalizedSearch),
              ),
            )
          : skills;
        return reply.send({
          enabled,
          ...createPaginatedResult(
            filtered.slice(offset, offset + limit),
            filtered.length,
            { limit, offset },
          ),
        });
      }

      return reply.send(
        await getPaginatedAgentActivationSkills({
          enabled,
          organizationId,
          userId: user.id,
          ...(agentId ? { agentId } : { environmentId: resolvedEnvironmentId }),
          pagination: { limit, offset },
          search,
        }),
      );
    },
  );

  fastify.get(
    "/api/agents/:id/activation-skill-policy",
    {
      schema: {
        operationId: RouteId.GetAgentActivationSkillPolicy,
        description: "Get an internal agent's skill activation policy",
        tags: ["Agents"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(
          AgentActivationSkillPolicyResponseSchema,
        ),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      const agent = await requireAgentReadAccess({ id, user, organizationId });
      if (agent.agentType !== "agent") {
        throw new ApiError(
          400,
          "Activation skill policies are available only for internal agents.",
        );
      }
      return reply.send(
        await agentActivationSkillPolicyService.getPolicy({
          agentId: id,
          organizationId,
          userId: user.id,
        }),
      );
    },
  );

  fastify.patch(
    "/api/agents/:id/activation-skill-policy",
    {
      schema: {
        operationId: RouteId.PatchAgentActivationSkillPolicy,
        description:
          "Apply a revisioned update to an internal agent's skill activation policy",
        tags: ["Agents"],
        params: z.object({ id: UuidIdSchema }),
        body: PatchAgentActivationSkillPolicySchema,
        response: constructResponseSchema(
          AgentActivationSkillPolicyResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      const {
        params: { id },
        body,
        user,
        organizationId,
      } = request;
      const agent = await requireAgentUpdateAccess({
        id,
        user,
        organizationId,
      });
      if (agent.agentType !== "agent") {
        throw new ApiError(
          400,
          "Activation skill policies are available only for internal agents.",
        );
      }
      const result = await agentActivationSkillPolicyService.patchPolicy({
        agentId: id,
        organizationId,
        userId: user.id,
        patch: body,
      });
      if (!result.changed) request.auditSkip = true;
      return reply.send(result.policy);
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
      await requireAgentSkillWriteAccess({
        id,
        user,
        organizationId,
      });
      return reply.send(
        await agentSkillAssignmentService.replaceAssignments({
          agentId: id,
          organizationId,
          userId: user.id,
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
      await requireAgentSkillWriteAccess({
        id,
        user,
        organizationId,
      });
      return reply.send(
        await agentSkillAssignmentService.replaceExclusions({
          agentId: id,
          organizationId,
          userId: user.id,
          excludedSkillIds: body.excludedSkillIds,
        }),
      );
    },
  );

  fastify.post(
    "/api/agents/:id/transfer-ownership",
    {
      schema: {
        operationId: RouteId.TransferAgentOwnership,
        description:
          "Transfer an agent or MCP gateway to another organization member",
        tags: ["Agents"],
        params: z.object({ id: UuidIdSchema }),
        body: z.object({ ownerId: z.string().min(1) }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      await transferAgentOwnership({
        agentId: id,
        ownerId: body.ownerId,
        userId: user.id,
        organizationId,
      });
      return reply.send({ success: true });
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
        checker.require(existingAgent.agentType, {
          action: "update",
          scope: existingAgent.id,
        });
      } catch {
        throw new ApiError(404, "Agent not found");
      }
      requireAgentRuntimePermission({
        agentType: existingAgent.agentType,
        runtime: body.runtime,
        isAdmin: checker.isAdmin(existingAgent.agentType),
      });

      // Who can reach the agent is not editable here: access lives in the
      // agent's permission policy, which the permissions API writes on its own.
      requireAgentModifyPermission({
        agentId: existingAgent.id,
        action: "update",
        checker,
        agentType: existingAgent.agentType,
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
        // through delegation. An environment would re-fence it, so reject a
        // narrowing change rather than silently scoping a shared resource.
        if (
          existingAgent.builtInAgentConfig.name === BUILT_IN_AGENT_IDS.ADVISOR
        ) {
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
        };
      } else {
        // `builtInAgentConfig` is server-owned and a trust attribute (drives
        // the advisor delegation exception), so a client cannot promote an
        // ordinary agent into a built-in by supplying it on update.
        const { builtInAgentConfig: _ignoredBuiltIn, ...bodyWithoutBuiltIn } =
          body;
        updateData = bodyWithoutBuiltIn;
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

      if (
        body.runtime !== undefined ||
        body.modelId !== undefined ||
        body.llmApiKeyId !== undefined
      ) {
        await assertAgentRuntimeModelCompatibility({
          runtime:
            body.runtime !== undefined ? body.runtime : existingAgent.runtime,
          agent: {
            llmApiKeyId:
              body.llmApiKeyId !== undefined
                ? body.llmApiKeyId
                : existingAgent.llmApiKeyId,
            modelId:
              body.modelId !== undefined ? body.modelId : existingAgent.modelId,
          },
          organizationId,
          userId: user.id,
        });
      }

      if (body.environmentId !== undefined) {
        await assertCanAssignEnvironment({
          userId: user.id,
          organizationId,
          environmentId: body.environmentId,
        });
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
        authorize: async (agent) => {
          if (agent.agentType === "llm_proxy") {
            throw new ApiError(400, LLM_PROXY_MANAGED_MESSAGE);
          }
          // A type the caller cannot update is answered as "not found", as the
          // single-agent update does, so a batch never confirms an agent
          // exists that the caller was not allowed to see.
          try {
            checker.require(agent.agentType, {
              action: "update",
              scope: agent.id,
            });
          } catch {
            throw new ApiError(404, "Agent not found");
          }

          const isAdmin = checker.isAdmin(agent.agentType);
          requireAgentModifyPermission({
            agentId: agent.id,
            action: "manage-permissions",
            checker,
            agentType: agent.agentType,
          });

          // Admin-ness (update on every agent of the type) is per agent type,
          // so these cannot be hoisted to a request-level 403 the way the team
          // validation above can. Team-admin no longer exists as a role action.
          if (!isAdmin) {
            if (scope === "org") {
              throw new ApiError(403, "Only admins can set scope to org");
            }
            if (scope === "team" || teams.length > 0) {
              throw new ApiError(403, "Only admins can set scope to team");
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
            checker.require(agent.agentType, {
              action: "delete",
              scope: agent.id,
            });
          } catch {
            throw new ApiError(404, "Agent not found");
          }
          requireAgentModifyPermission({
            agentId: agent.id,
            action: "delete",
            checker,
            agentType: agent.agentType,
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
        checker.require(agent.agentType, { action: "delete", scope: agent.id });
      } catch {
        throw new ApiError(404, "Agent not found");
      }

      // Requires a delete grant on this agent
      requireAgentModifyPermission({
        agentId: agent.id,
        action: "delete",
        checker,
        agentType: agent.agentType,
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
        checker.require(agent.agentType, { action: "delete", scope: agent.id });
      } catch {
        throw new ApiError(404, "Agent not found");
      }

      requireAgentModifyPermission({
        agentId: agent.id,
        action: "delete",
        checker,
        agentType: agent.agentType,
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
    checker.require(agent.agentType, { action: "read", scope: agent.id });
  } catch {
    throw new ApiError(404, "Agent not found");
  }

  if (!checker.isAdmin(agent.agentType)) {
    // Team/author visibility, mirroring GetAgent's non-admin filter. The
    // already-fetched agent serves as the access context — no re-fetch.
    const hasAccess = await AgentTeamModel.userHasAgentAccess({
      userId: params.userId,
      agentId: params.id,
      isAgentAdmin: false,
      agentAccessContext: agent,
    });
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
  const scopedTypes =
    params.status === "deleted"
      ? []
      : (params.checker.getAgentTypesWithScopedPermission?.("read") ?? []);

  if (params.effectiveTypes) {
    for (const type of params.effectiveTypes) {
      if (!scopedTypes.includes(type)) params.checker.require(type, action);
    }
    return undefined;
  }

  const permittedTypes = [
    ...new Set([
      ...params.checker.getAgentTypesWithPermission(action),
      ...scopedTypes,
    ]),
  ];
  if (permittedTypes.length === 0) {
    throw new ApiError(403, AGENT_READ_FORBIDDEN_MESSAGE);
  }

  return permittedTypes;
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
    userId,
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
}): Promise<Agent> {
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
    checker.require(agent.agentType, { action: "read", scope: agent.id });
  } catch {
    throw new ApiError(404, "Agent not found");
  }

  if (!checker.isAdmin(agent.agentType)) {
    const filteredAgent = await AgentModel.findById(id, user.id, false);
    if (!filteredAgent) {
      throw new ApiError(404, "Agent not found");
    }
  }

  return agent;
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
}): Promise<Agent> {
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
    checker.require(agent.agentType, { action: "update", scope: agent.id });
  } catch {
    throw new ApiError(404, "Agent not found");
  }

  requireAgentModifyPermission({
    agentId: agent.id,
    action: "update",
    checker,
    agentType: agent.agentType,
  });
  return agent;
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
 * skill resource cannot reach these routes at all. The per-skill check is
 * enforced by the assignment service: publishing or excluding a skill
 * requires that a grant already lets the caller read it. Neither half implies
 * the other — visibility is a property of the skill, the capability a
 * property of the role. Gateway permission alone is not sufficient for
 * either, because `mcpGateway:update` is a default member permission and
 * publishing hands the skill's full body to every holder of the gateway's
 * token.
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
}): Promise<void> {
  await requireAgentUpdateAccess(params);
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

function requireAgentRuntimePermission(params: {
  agentType: AgentType;
  runtime?: AgentRuntime | null;
  isAdmin: boolean;
}): void {
  if (params.runtime == null) return;
  if (!config.agentRuntime.enabled) {
    throw new ApiError(400, "Agent Runtime is not enabled");
  }
  if (params.agentType !== "agent") {
    throw new ApiError(400, "Agent Runtime can only be configured for Agents");
  }
  if (params.runtime.privileged && !params.isAdmin) {
    throw new ApiError(
      403,
      "Only Agent administrators can enable a privileged background deployment",
    );
  }
  if (params.runtime.privileged && !config.agentRuntime.allowPrivileged) {
    throw new ApiError(
      403,
      "Privileged background deployments are disabled by the deployment operator",
    );
  }
}

async function assertAgentRuntimeModelCompatibility(params: {
  runtime:
    | Pick<AgentRuntime, "command" | "inferenceProtocol">
    | null
    | undefined;
  agent: Pick<Agent, "llmApiKeyId" | "modelId">;
  organizationId: string;
  userId: string;
}): Promise<void> {
  const { runtime } = params;
  if (!runtime) return;
  if (params.agent.llmApiKeyId || params.agent.modelId) {
    if (!params.agent.llmApiKeyId || !params.agent.modelId) {
      throw new ApiError(
        400,
        "An agent's model and API key must be set together",
      );
    }
    const userTeamIds = await TeamModel.getUserTeamIds(params.userId);
    const availableKeys = await LlmProviderApiKeyModel.getAvailableKeysForUser(
      params.organizationId,
      params.userId,
      userTeamIds,
    );
    const selectedKey = availableKeys.find(
      (key) => key.id === params.agent.llmApiKeyId,
    );
    const selectedModelIsLinked = selectedKey
      ? (
          await LlmProviderApiKeyModelLinkModel.getModelsForApiKeyIds([
            selectedKey.id,
          ])
        ).some(({ model }) => model.id === params.agent.modelId)
      : false;
    if (!selectedModelIsLinked) {
      throw new ApiError(
        400,
        "The selected model and API key must be linked and available to you",
      );
    }
  }
  const result = await getResolvedAgentRuntimeModelCompatibility({
    ...params,
    runtime,
  });
  if (!result.compatibility.compatible) {
    throw new ApiError(409, result.compatibility.message);
  }
}

/** Whether two id lists hold the same set of ids, order aside. */
function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}
