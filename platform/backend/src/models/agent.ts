import {
  type ArchestraToolShortName,
  BUILT_IN_AGENT_IDS,
  type CursorQuery,
  DEFAULT_LLM_PROXY_NAME,
  getCreationDefaultArchestraToolShortNames,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  type PaginationQuery,
  PERSONAL_MCP_GATEWAY_NAME,
  PLAYWRIGHT_MCP_CATALOG_ID,
  PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAMES,
  parseFullToolName,
  providerRequiresPerUserCredential,
  RESOURCE_ACCESS_RELATIONS,
  type ResourcePermissionGrant,
  SKILL_ARCHESTRA_TOOL_SHORT_NAMES,
  type SupportedProvider,
  TimeInMs,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  urlSlugify,
} from "@archestra/shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  getTableColumns,
  getTableName,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  max,
  ne,
  not,
  notExists,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { type AnyPgColumn, unionAll } from "drizzle-orm/pg-core";
import { z } from "zod";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import { hardDelete, restore, softDelete } from "@/database/soft-delete";
import {
  createCursorPaginatedResult,
  createPaginatedResult,
  decodeCursor,
  type PaginatedResult,
} from "@/database/utils/pagination";
import { enterpriseTier } from "@/enterprise-tier";
import logger from "@/logging";
import { registerProcessLocalCache } from "@/process-local-cache-registry";
import {
  type Agent,
  type AgentActivationSkillMode,
  AgentActivationSkillModeSchema,
  type AgentListItem,
  type AgentOption,
  type AgentScope,
  type AgentScopeFilter,
  type AgentToolRef,
  type AgentType,
  type ChatAgentRoster,
  GATEWAY_CAPABLE_AGENT_TYPES,
  type GatewayAgent,
  type InsertAgent,
  type McpServerAgentUsage,
  type ReadinessAgent,
  type SortingQuery,
  type UpdateAgent,
} from "@/types";
import type { AgentOptionFilters } from "@/types/agent";
import { isUniqueConstraintError } from "@/utils/db";
import { escapeLikePattern } from "@/utils/sql-search";
import { isUuid } from "@/utils/uuid";
import A2aRemoteAgentModel from "./a2a-remote-agent";
import AgentActivationSkillRuleModel from "./agent-activation-skill-rule";
import AgentConnectorAssignmentModel from "./agent-connector-assignment";
import AgentExcludedConnectorModel from "./agent-excluded-connector";
import AgentExcludedSkillModel from "./agent-excluded-skill";
import AgentExcludedSubagentModel from "./agent-excluded-subagent";
import AgentExcludedToolModel from "./agent-excluded-tool";
import AgentKnowledgeBaseModel from "./agent-knowledge-base";
import AgentLabelModel from "./agent-label";
import AgentPinModel from "./agent-pin";
import AgentSkillModel from "./agent-skill";
import AgentSuggestedPromptModel from "./agent-suggested-prompt";
import AgentTeamModel from "./agent-team";
import AgentToolModel from "./agent-tool";
import AgentUserModel from "./agent-user";
import AgentVersionModel from "./agent-version";
import CreatedByModel from "./created-by";
import { idArrayCondition } from "./id-array-condition";
import { latestCreatedAtByKey } from "./latest-created-at";
import McpToolCallModel from "./mcp-tool-call";
import OrganizationModel from "./organization";
import ResourcePermissionPolicyModel, {
  type ObjectPolicy,
} from "./resource-permission-policy";
import ResourcePermissionSubjectModel, {
  type GrantPrincipal,
  type PrincipalSource,
  type ResourceAccessSelection,
} from "./resource-permission-subject";
import ToolModel from "./tool";

type AgentRosterOptions = {
  agentType?: AgentType;
  authorization?: { organizationId: string; baseReadTypes: AgentType[] };
  agentTypes?: AgentType[];
  excludeBuiltIn?: boolean;
  scope?: AgentScope;
  excludeOtherPersonalAgents?: boolean;
  status?: AgentRecordStatus;
  /**
   * Keep only agents that enforce a missing-credential behavior. The
   * readiness pre-flight has nothing to say about the rest, and this keeps
   * it from loading an organization's whole agent roster to discard it.
   */
  onlyEnforcingMissingCredentials?: boolean;
  /**
   * Attach each agent's assigned tools. Defaults to true. The refs carry
   * every tool's name and description, so on an organization of any size
   * they are the great majority of the result's size — callers that only
   * need the roster (which agents exist, what they are called, which model
   * they run) should turn this off and get `tools: []`, which here means
   * "not requested" rather than "none assigned".
   */
  includeTools?: boolean;
  /**
   * Return the compact roster used to initialize chat. The response keeps
   * the full Agent wire shape for compatibility, but fields the chat does
   * not consume are empty and oversized embedded icons are omitted.
   */
  view?: "chat" | "options";
  ids?: string[];
};

type AgentListFilters = {
  organizationId?: string;
  authorization?: { organizationId: string; baseReadTypes: AgentType[] };
  ids?: string[];
  /** Rows the list shows elsewhere, such as the viewer's automatic pins. */
  excludeIds?: string[];
  name?: string;
  agentType?: AgentType;
  agentTypes?: AgentType[];
  scope?: AgentScopeFilter;
  teamIds?: string[];
  authorIds?: string[];
  excludeAuthorIds?: string[];
  excludeOtherPersonalAgents?: boolean;
  /**
   * The list's "Show", "Shared with", and "Owner" filters; see
   * {@link ResourceAccessSelection}.
   */
  access?: ResourceAccessSelection;
  /**
   * Add the built-in agents to the list. The `access` filter does not apply to
   * them: they have no author and are listed only to agent admins.
   */
  includeBuiltIn?: boolean;
  /** `chat` keeps the system chat assistant in the list for chat selection. */
  view?: "chat";
  labels?: Record<string, string[]>;
  status?: AgentRecordStatus;
  providerApiKeyId?: string;
  /** Caller-relative pin filter for the paginated Agents surface. */
  pinned?: boolean;
  /**
   * Attach each agent's assigned tools. Defaults to true; off, agents come
   * back with `tools: []`, meaning "not requested" rather than "none
   * assigned".
   */
  includeTools?: boolean;
};

type AgentCatalogRowRef = {
  type: "agent" | "external";
  id: string;
};

type AgentCatalogCandidatePage = {
  rows: AgentCatalogRowRef[];
  total: number;
  agentTotal: number;
  externalAgentTotal: number;
};

class AgentModel {
  /**
   * Process-local cache for {@link AgentModel.resolveIdFromIdOrSlug}. The
   * lookup runs on every MCP-gateway request before auth, so under load it is
   * both a meaningful share of pool traffic and the first query to surface
   * pool starvation. id/slug → id mappings change rarely; the short TTL bounds
   * staleness after a slug change or deletion (requests for a just-deleted
   * agent still fail downstream where the agent row is actually loaded).
   */
  private static readonly resolveIdCache = registerProcessLocalCache(
    new LRUCacheManager<string>({
      maxSize: 10_000,
      defaultTtl: TimeInMs.Minute,
    }),
  );

  /**
   * Reset the resolve cache. The shared test setup clears it between tests
   * via the process-local cache registry; tests that exercise post-deletion
   * staleness clear it explicitly through this hook.
   */
  static clearResolveIdCache(): void {
    AgentModel.resolveIdCache.clear();
  }

  /**
   * The agents a bulk route was asked to act on, fenced to one organization
   * and read in two queries rather than one per id.
   *
   * The organization fence is load-bearing rather than tidy: ids arrive
   * straight from a request body and `requireAgentModifyPermission`
   * short-circuits for an admin — an admin of the CALLER's organization — so
   * an unfenced read would let a foreign id sail past the scope checks.
   * Dropping such an id here makes it indistinguishable from one that never
   * existed, which is what the single-agent routes answer too.
   *
   * Only the fields a bulk route authorizes or reports on are selected, so
   * this stays cheap for a 500-id batch. Soft-deleted rows are excluded, as
   * `findById` excludes them.
   */
  static async findForBulk(params: {
    organizationId: string;
    agentIds: string[];
  }): Promise<
    Array<
      Pick<
        Agent,
        "id" | "name" | "agentType" | "scope" | "authorId" | "isPersonalGateway"
      > & { isBuiltIn: boolean; teamIds: string[] }
    >
  > {
    const { organizationId, agentIds } = params;
    if (agentIds.length === 0) {
      return [];
    }

    const rows = await db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        agentType: schema.agentsTable.agentType,
        scope: schema.agentsTable.scope,
        authorId: schema.agentsTable.authorId,
        createdByServiceAccountId: schema.agentsTable.createdByServiceAccountId,
        isPersonalGateway: schema.agentsTable.isPersonalGateway,
        isBuiltIn: schema.agentsTable.builtIn,
      })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.organizationId, organizationId),
          inArray(schema.agentsTable.id, agentIds),
          notDeleted(schema.agentsTable),
        ),
      );

    const teamsByAgent = await AgentTeamModel.getTeamDetailsForAgents(
      rows.map((row) => row.id),
    );

    return rows.map(({ isBuiltIn, ...row }) => ({
      ...row,
      // `built_in` is a generated column, so drizzle types it nullable even
      // though the expression it computes never is.
      isBuiltIn: isBuiltIn === true,
      teamIds: (teamsByAgent.get(row.id) ?? []).map((team) => team.id),
    }));
  }

  /**
   * Visibility snapshot for a bulk route's audit record, used for both the
   * before and after side. Ids, names, scope and team assignment only: enough
   * to see what the batch moved, with nothing secret in it.
   *
   * Soft-deleted rows are included so a bulk delete's "after" side still names
   * what it removed rather than going empty.
   */
  static async findVisibilityForBulkAudit(params: {
    organizationId: string;
    agentIds: string[];
  }): Promise<
    Array<{
      id: string;
      name: string;
      scope: AgentScope;
      deleted: boolean;
      teamIds: string[];
    }>
  > {
    const { organizationId, agentIds } = params;
    if (agentIds.length === 0) {
      return [];
    }

    const rows = await db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        scope: schema.agentsTable.scope,
        deletedAt: schema.agentsTable.deletedAt,
      })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.organizationId, organizationId),
          inArray(schema.agentsTable.id, agentIds),
        ),
      )
      // Sorted so two reads of an unchanged batch produce an identical
      // snapshot and the audit diff stays empty; row order is unspecified.
      .orderBy(schema.agentsTable.id);

    const teamsByAgent = await AgentTeamModel.getTeamDetailsForAgents(
      rows.map((row) => row.id),
    );

    return rows.map(({ deletedAt, ...row }) => ({
      ...row,
      deleted: deletedAt !== null,
      teamIds: (teamsByAgent.get(row.id) ?? []).map((team) => team.id).sort(),
    }));
  }

  static async findBasicByOrganizationIdAndIds(params: {
    organizationId: string;
    agentIds: string[];
  }): Promise<Array<Pick<Agent, "id" | "name" | "agentType">>> {
    const { organizationId, agentIds } = params;

    if (agentIds.length === 0) {
      return [];
    }

    return await db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        agentType: schema.agentsTable.agentType,
      })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.organizationId, organizationId),
          inArray(schema.agentsTable.id, agentIds),
          notDeleted(schema.agentsTable),
        ),
      )
      .orderBy(desc(schema.agentsTable.createdAt), desc(schema.agentsTable.id));
  }

  /**
   * Auto-mode agents (accessAllTools = true) grouped by organization. These
   * agents have implicit access to every tool, so they can reach every MCP
   * server without an explicit tool assignment. They are therefore surfaced
   * separately from `assignedAgents` (e.g. below a divider in the server card
   * "Used by N agents" tooltip). Batched by organization to avoid an N+1 when
   * decorating a list of servers.
   */
  static async getAutoModeAgentDetailsByOrganizations(
    organizationIds: string[],
  ): Promise<Map<string, McpServerAgentUsage[]>> {
    const agentsByOrg = new Map<string, McpServerAgentUsage[]>();
    for (const organizationId of organizationIds) {
      agentsByOrg.set(organizationId, []);
    }
    if (organizationIds.length === 0) {
      return agentsByOrg;
    }

    const rows = await db
      .select({
        organizationId: schema.agentsTable.organizationId,
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        agentType: schema.agentsTable.agentType,
        scope: schema.agentsTable.scope,
        ownerId: schema.agentsTable.authorId,
        ownerEmail: schema.usersTable.email,
      })
      .from(schema.agentsTable)
      // Personal agents share a name across members, so the owner is what
      // tells them apart in the UI. LEFT JOIN: `author_id` is nullable and
      // nulls out when the author is deleted.
      .leftJoin(
        schema.usersTable,
        eq(schema.agentsTable.authorId, schema.usersTable.id),
      )
      .where(
        and(
          inArray(schema.agentsTable.organizationId, organizationIds),
          eq(schema.agentsTable.accessAllTools, true),
          notDeleted(schema.agentsTable),
        ),
      )
      .orderBy(asc(schema.agentsTable.name), asc(schema.agentsTable.id));

    for (const { organizationId, ...agent } of rows) {
      agentsByOrg.get(organizationId)?.push(agent);
    }

    return agentsByOrg;
  }

  static async activeNameExistsInOrganization(params: {
    name: string;
    organizationId: string;
  }): Promise<boolean> {
    const [row] = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.name, params.name),
          eq(schema.agentsTable.organizationId, params.organizationId),
          notDeleted(schema.agentsTable),
        ),
      )
      .limit(1);

    return row !== undefined;
  }

  static async findActiveIdByNameInOrganization(params: {
    name: string;
    organizationId: string;
    agentType?: AgentType;
  }): Promise<string | null> {
    const conditions: SQL[] = [
      eq(schema.agentsTable.name, params.name),
      eq(schema.agentsTable.organizationId, params.organizationId),
      notDeleted(schema.agentsTable),
    ];

    if (params.agentType) {
      conditions.push(eq(schema.agentsTable.agentType, params.agentType));
    }

    const [row] = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(and(...conditions))
      .limit(1);

    return row?.id ?? null;
  }

  /**
   * Set each agent's `scope` from its grants instead of the retired column,
   * which every new agent stores as `personal`: `org` when they reach the
   * organization or a role, `team` when they reach a team, `personal`
   * otherwise. An LLM proxy has no grants and keeps its column.
   */
  /**
   * An agent that is not someone else's personal one: it reaches more than
   * its author by grants, or `userId` wrote it, or holds a grant on it. An
   * overseer who can read every agent still does not list others' private
   * ones.
   */
  static notOthersPersonalCondition(params: {
    userId: string;
    principals: GrantPrincipal[];
  }): SQL {
    return or(
      not(agentAudienceIs("personal")),
      eq(schema.agentsTable.authorId, params.userId),
      explicitAgentReadCondition(params.principals),
    ) as SQL;
  }

  static async populateGrantedScope(
    agents: Pick<Agent, "id" | "organizationId" | "agentType" | "scope">[],
    policies?: ObjectPolicy[],
  ): Promise<void> {
    const byKey = new Map<string, string[]>();
    for (const agent of agents) {
      if (agent.agentType === "llm_proxy") continue;
      const resource =
        agent.agentType === "mcp_gateway" ? "mcpGateway" : "agent";
      const key = `${agent.organizationId}\u0000${resource}`;
      const scopes = byKey.get(key);
      if (scopes) scopes.push(agent.id);
      else byKey.set(key, [agent.id]);
    }
    const audiences = new Map<string, AgentScope>();
    for (const [key, scopes] of byKey) {
      const [organizationId, resource] = key.split("\u0000") as [
        string,
        "agent" | "mcpGateway",
      ];
      const found = await ResourcePermissionPolicyModel.findAudiences({
        organizationId,
        resource,
        scopes,
        policies,
      });
      for (const [id, { audience }] of found) audiences.set(id, audience);
    }
    for (const agent of agents) {
      const audience = audiences.get(agent.id);
      if (audience) agent.scope = audience;
    }
  }

  /**
   * Populate author identity on agents by looking up users in one batch.
   */
  private static async populateAuthorNames(
    agents: Pick<
      Agent,
      | "authorId"
      | "createdByServiceAccountId"
      | "authorName"
      | "authorEmail"
      | "createdBy"
    >[],
  ): Promise<void> {
    const creators = await CreatedByModel.resolve(
      agents.map((agent) => CreatedByModel.id(agent, agent.authorId)),
    );
    for (const agent of agents) {
      const id = CreatedByModel.id(agent, agent.authorId);
      const author = id ? creators.get(id) : null;
      agent.authorName = author?.name ?? null;
      agent.authorEmail = author?.email ?? null;
      agent.createdBy = author ?? null;
    }
  }

  /**
   * Populate knowledgeBaseIds on agents via batch lookup from the junction table.
   */
  private static async populateKnowledgeBaseIds(
    agents: Agent[],
  ): Promise<void> {
    const agentIds = agents.map((a) => a.id);
    if (agentIds.length === 0) return;

    const kbMap =
      await AgentKnowledgeBaseModel.getKnowledgeBaseIdsForAgents(agentIds);
    for (const agent of agents) {
      agent.knowledgeBaseIds = kbMap.get(agent.id) ?? [];
    }
  }

  /**
   * Populate suggestedPrompts on agents via batch lookup.
   */
  private static async populateSuggestedPrompts(
    agents: Agent[],
  ): Promise<void> {
    const agentIds = agents.map((a) => a.id);
    if (agentIds.length === 0) return;

    const promptsMap = await AgentSuggestedPromptModel.getForAgents(agentIds);
    for (const agent of agents) {
      agent.suggestedPrompts = promptsMap.get(agent.id) ?? [];
    }
  }

  /**
   * Populate lastUsedAt on agents: the most recent moment anything ran through
   * the agent, whichever came last of
   *
   * - an MCP request (any JSON-RPC method) routed through its gateway endpoint,
   * - an LLM call made on its behalf.
   *
   * Null when neither ever happened. Both halves are needed because the two
   * kinds of agent are used differently: an MCP gateway is all requests and no
   * LLM calls, while an agent driven from chat may answer for months without
   * ever routing a tool call. Reading only the MCP log would report such an
   * agent as never used.
   */
  private static async populateLastUsedAt(agents: Agent[]): Promise<void> {
    const agentIds = agents.map((a) => a.id);
    if (agentIds.length === 0) return;

    const [lastCallMap, lastInteractionMap] = await Promise.all([
      McpToolCallModel.getLastCallAtForAgents(agentIds),
      AgentModel.getLastInteractionAtForAgents(agentIds),
    ]);

    for (const agent of agents) {
      const lastCallAt = lastCallMap.get(agent.id) ?? null;
      const lastInteractionAt = lastInteractionMap.get(agent.id) ?? null;
      agent.lastUsedAt = mostRecent(lastCallAt, lastInteractionAt);
    }
  }

  /**
   * When each agent last had an LLM call made on its behalf, absent for agents
   * with none. Read straight off `interactions` rather than through
   * `InteractionModel`, which imports this module — the same reason the
   * `lastUsedAt` sort below reads `mcpToolCallsTable` directly.
   */
  private static async getLastInteractionAtForAgents(
    agentIds: string[],
  ): Promise<Map<string, Date>> {
    return latestCreatedAtByKey({
      table: schema.interactionsTable,
      keyColumn: schema.interactionsTable.profileId,
      createdAtColumn: schema.interactionsTable.createdAt,
      keys: agentIds,
    });
  }

  /**
   * Resolve each agent's configured LLM provider server-side so every viewer
   * sees the agent's true provider — even one who can't access the owner's
   * per-user key. Provider comes from the attached key, falling back to the
   * pinned model's provider when only a model is set.
   */
  private static async populateResolvedLlm(agents: Agent[]): Promise<void> {
    if (agents.length === 0) return;

    const apiKeyIds = [
      ...new Set(
        agents
          .map((a) => a.llmApiKeyId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const modelIds = [
      ...new Set(
        agents.map((a) => a.modelId).filter((id): id is string => id !== null),
      ),
    ];

    const [keyRows, modelRows] = await Promise.all([
      apiKeyIds.length > 0
        ? db
            .select({
              id: schema.llmProviderApiKeysTable.id,
              name: schema.llmProviderApiKeysTable.name,
              provider: schema.llmProviderApiKeysTable.provider,
            })
            .from(schema.llmProviderApiKeysTable)
            .where(inArray(schema.llmProviderApiKeysTable.id, apiKeyIds))
        : Promise.resolve([]),
      modelIds.length > 0
        ? db
            .select({
              id: schema.modelsTable.id,
              provider: schema.modelsTable.provider,
              // The human-facing model identifier (e.g. "gpt-4"), distinct from
              // the row's UUID `id`.
              modelName: schema.modelsTable.modelId,
            })
            .from(schema.modelsTable)
            .where(inArray(schema.modelsTable.id, modelIds))
        : Promise.resolve([]),
    ]);

    const keyProviderMap = new Map(keyRows.map((r) => [r.id, r.provider]));
    const keyNameMap = new Map(keyRows.map((r) => [r.id, r.name]));
    const modelProviderMap = new Map(modelRows.map((r) => [r.id, r.provider]));
    const modelNameMap = new Map(modelRows.map((r) => [r.id, r.modelName]));

    for (const agent of agents) {
      const provider: SupportedProvider | null =
        (agent.llmApiKeyId ? keyProviderMap.get(agent.llmApiKeyId) : null) ??
        (agent.modelId ? modelProviderMap.get(agent.modelId) : null) ??
        null;
      agent.resolvedLlmProvider = provider;
      agent.resolvedLlmProviderKeyName = agent.llmApiKeyId
        ? (keyNameMap.get(agent.llmApiKeyId) ?? null)
        : null;
      agent.llmProviderRequiresPerUserCredential = provider
        ? providerRequiresPerUserCredential(provider)
        : false;
      // The model's human name, so a viewer who can't access the configured
      // key still sees "gpt-4" rather than the model row's UUID.
      agent.resolvedLlmModelName = agent.modelId
        ? (modelNameMap.get(agent.modelId) ?? null)
        : null;
    }
  }

  /**
   * Populate `sandboxAvailable` per agent for the requesting user. No-op without
   * a userId (system/background callers): the field stays absent and clients
   * treat that as unavailable. `isSkillSandboxAvailableForAgent` short-circuits
   * cheaply when the sandbox feature is off, so this is near-free in the common
   * case; the per-agent permission/tool lookups only run when it is enabled.
   */
  private static async populateSandboxAvailability(
    agents: Agent[],
    userId: string | undefined,
  ): Promise<void> {
    if (agents.length === 0 || !userId) return;

    // Lazy: the availability check reaches into the service layer, which
    // would otherwise load with every model.
    const { isSkillSandboxAvailableForAgent } = await import(
      "@/skills/skill-sandbox-availability"
    );
    await Promise.all(
      agents.map(async (agent) => {
        agent.sandboxAvailable = await isSkillSandboxAvailableForAgent({
          userId,
          organizationId: agent.organizationId,
          agentId: agent.id,
        });
      }),
    );
  }

  /**
   * Populate connectorIds on agents via batch lookup from the junction table.
   */
  private static async populateConnectorIds(agents: Agent[]): Promise<void> {
    const agentIds = agents.map((a) => a.id);
    if (agentIds.length === 0) return;

    const connectorMap =
      await AgentConnectorAssignmentModel.getConnectorIdsForAgents(agentIds);
    for (const agent of agents) {
      agent.connectorIds = connectorMap.get(agent.id) ?? [];
    }
  }

  static async create(
    {
      teams,
      users,
      labels,
      knowledgeBaseIds,
      connectorIds,
      suggestedPrompts,
      activationSkillPolicy,
      ...agent
    }: Omit<InsertAgent, "scope"> & {
      /**
       * The retired visibility column; it defaults to "personal" and nothing
       * reads it. The grants decide who reaches the agent.
       */
      scope?: InsertAgent["scope"];
      activationSkillMode?: AgentActivationSkillMode;
      isPersonalGateway?: boolean;
      // Server-owned like isPersonalGateway: omitted from the request schemas
      // (the skill-assignment routes are the only client-facing write path)
      // but a real column create() honours for internal callers and fixtures.
      accessAllSkills?: boolean;
      slug?: string;
    },
    authorId?: string,
    options?: {
      /**
       * Skip the All-tools exclusion pre-fill. Used by agent import, which
       * assigns the payload's tools AFTER create and then runs the pre-fill
       * itself so those assignments are not pre-excluded.
       */
      skipExclusionPrefill?: boolean;
      initialPermissionGrants?: ResourcePermissionGrant[];
      /** Publish to the whole organization; for system callers only. */
      publishToOrganization?: boolean;
      /**
       * Skip auto-assigning the creation-default built-in tool set. Used by
       * clone and import, which set their own authoritative assignment set
       * right after create (a verbatim copy of the source agent, or the import
       * payload's tools). Without this, the additive default assignment would
       * force built-ins the source/payload deliberately lacked (e.g. todo_write)
       * onto the new agent.
       */
      skipCreationDefaultTools?: boolean;
      /** Caller will fork version 1 after completing a staged create policy. */
      deferInitialVersionFork?: boolean;
    },
  ): Promise<Agent> {
    // Auto-assign organizationId if not provided
    let organizationId = agent.organizationId;
    if (!organizationId) {
      const [firstOrg] = await db
        .select({ id: schema.organizationsTable.id })
        .from(schema.organizationsTable)
        .limit(1);
      organizationId = firstOrg?.id || "";
    }

    // Dynamic tool access only works through the search/run dispatch surface, so
    // an all-tools agent must use progressive loading. Coerce here so every
    // create path (UI, MCP tools, REST, import, clone) keeps the invariant.
    if (agent.accessAllTools === true) {
      agent.toolExposureMode = "search_and_run_only";
    }

    // All-tools agents are inserted with the toggle OFF and flipped on at the
    // end, in one transaction with the exclusion pre-fill (see below), so a
    // committed agent can never sit in Auto mode without its pre-filled
    // exclusions — a failure between insert and flip leaves it in Custom mode
    // (fail-closed) instead of fail-open.
    const enableAccessAllTools = agent.accessAllTools === true;

    const slug =
      agent.agentType === "mcp_gateway"
        ? agent.slug || (await AgentModel.generateUniqueSlug(agent.name))
        : undefined;

    const [createdAgent] = await AgentModel.insertWithSlugRetry(
      {
        ...agent,
        // A staged policy is always inserted fail-closed. The policy service
        // installs its exact rules and flips to the requested mode before the
        // create route returns.
        ...(activationSkillPolicy && {
          activationSkillMode: "manual" as const,
        }),
        ...(enableAccessAllTools && { accessAllTools: false }),
        organizationId,
        ...(slug && { slug }),
        ...(authorId && { authorId }),
      },
      {
        grants: options?.initialPermissionGrants,
        publishToOrganization: options?.publishToOrganization,
      },
    );

    // Assign teams to the agent if provided
    if (teams && teams.length > 0) {
      await AgentTeamModel.assignTeamsToAgent(createdAgent.id, teams);
    }

    // Share with named individuals if provided. Additive to the scope, so a
    // personal agent can reach a colleague without being published wider.
    if (users && users.length > 0) {
      await AgentUserModel.syncAgentUsers(createdAgent.id, users);
    }

    // Assign labels to the agent if provided
    if (labels && labels.length > 0) {
      await AgentLabelModel.syncAgentLabels(createdAgent.id, labels);
    }

    // Assign knowledge bases if provided
    if (knowledgeBaseIds && knowledgeBaseIds.length > 0) {
      await AgentKnowledgeBaseModel.syncForAgent(
        createdAgent.id,
        knowledgeBaseIds,
      );
    }

    // Assign connectors if provided
    if (connectorIds && connectorIds.length > 0) {
      await AgentConnectorAssignmentModel.syncForAgent(
        createdAgent.id,
        connectorIds,
      );
    }

    // Sync suggested prompts if provided
    if (suggestedPrompts && suggestedPrompts.length > 0) {
      await AgentSuggestedPromptModel.syncForAgent({
        agentId: createdAgent.id,
        prompts: suggestedPrompts,
      });
    }

    // For internal agents, create a delegation tool so other agents can delegate to this one
    if (createdAgent.agentType === "agent") {
      await ToolModel.findOrCreateDelegationTool(createdAgent.id);
    }

    // Auto-assign the creation-default built-in tool set. Which groups apply
    // is composed by the shared getCreationDefaultArchestraToolShortNames from
    // the same flags the frontend create form reads, so the pre-selected set
    // in the form and the server-side assignment cannot drift. Skipped by
    // clone/import, which install their own authoritative assignment set.
    if (!options?.skipCreationDefaultTools) {
      const organization = await OrganizationModel.getById(organizationId);
      const creationDefaultShortNames = new Set<ArchestraToolShortName>(
        getCreationDefaultArchestraToolShortNames({
          skillsEnabled: organization?.skillToolsEnabled === true,
          sandboxEnabled: config.skillsSandbox.enabled,
          openappaEnabled: enterpriseTier.isOpenappaActive(),
        }),
      );
      const composesGroup = (group: readonly ArchestraToolShortName[]) =>
        group.every((shortName) => creationDefaultShortNames.has(shortName));

      // Always-on defaults (todo_write, query_knowledge_sources).
      await ToolModel.assignDefaultArchestraToolsToAgent(createdAgent.id);

      // Agent Skill tools — org opted in via the "Enable and create a new
      // skill" empty-state action.
      if (composesGroup(SKILL_ARCHESTRA_TOOL_SHORT_NAMES)) {
        await ToolModel.assignSkillToolsToAgent(
          createdAgent.id,
          organizationId,
        );
      }

      // MCP App management tools — always on, so new agents can build and use
      // apps without per-agent setup.
      await ToolModel.assignAppToolsToAgent(createdAgent.id, organizationId);

      // Persistent-files tools, plus the code runtime tools when the runtime
      // is on — the same composition as the create form.
      if (composesGroup(PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAMES)) {
        await ToolModel.assignSandboxToolsToAgent(
          createdAgent.id,
          organizationId,
        );
      }
    }

    // Flip All-tools mode on last, atomically with the exclusion pre-fill.
    // Running after the auto-assignments above means the pre-fill sees the
    // final assignment state (assigned tools are never pre-excluded), and a
    // pre-fill failure rolls the flip back rather than committing an All-mode
    // agent without its exclusion baseline.
    if (enableAccessAllTools) {
      const [flipped] = await withDbTransaction(async (tx) => {
        if (!options?.skipExclusionPrefill) {
          await AgentExcludedToolModel.prefillForAllToolsMode(
            createdAgent.id,
            tx,
          );
        }
        return tx
          .update(schema.agentsTable)
          .set({
            accessAllTools: true,
            toolExposureMode: "search_and_run_only",
          })
          .where(eq(schema.agentsTable.id, createdAgent.id))
          .returning();
      });
      if (flipped) {
        Object.assign(createdAgent, flipped);
      }
    }

    // Fork version 1 once the full config of this create (row, junctions,
    // auto-assigned tools, exclusion pre-fill) is in place. A caller that
    // defers this fork must capture version 1 after it finishes its remaining
    // initialization. Best-effort: a versioning failure must never fail the
    // create itself.
    if (!options?.deferInitialVersionFork) {
      const fork = await AgentVersionModel.forkIfChangedBestEffort(
        createdAgent.id,
      );
      if (fork) {
        createdAgent.latestVersion = fork.version;
      }
    }

    // Get team details and tools for the created agent
    const [teamDetails, assignedTools] = await Promise.all([
      AgentTeamModel.getTeamDetailsForAgent(createdAgent.id),
      db
        .select({ tool: agentToolRefColumns })
        .from(schema.agentToolsTable)
        .innerJoin(
          schema.toolsTable,
          eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
        )
        .where(eq(schema.agentToolsTable.agentId, createdAgent.id)),
    ]);

    const result: Agent = {
      ...createdAgent,
      tools: assignedTools.map((row) => row.tool),
      teams: teamDetails,
      users: [],
      labels: await AgentLabelModel.getLabelsForAgent(createdAgent.id),
      knowledgeBaseIds: knowledgeBaseIds ?? [],
      connectorIds: connectorIds ?? [],
      suggestedPrompts: suggestedPrompts ?? [],
    };
    await AgentModel.populateGrantedScope([result]);
    AgentModel.filterUnavailableKnowledgeTools([result]);

    return result;
  }

  /** The authorized chat roster without editing or selected-agent hydration. */
  static async findChatRoster(params: {
    userId: string;
    isAgentAdmin: boolean;
    options: AgentRosterOptions;
  }): Promise<ChatAgentRoster[]> {
    const where = await AgentModel.buildRosterWhere(params);
    return AgentModel.findChatRosterRows(where);
  }

  /** Bounded fallback identities; explicit URL references use findChatRoster IDs. */
  static async findChatRosterBootstrap(params: {
    userId: string;
    isAgentAdmin: boolean;
    options: AgentRosterOptions;
  }): Promise<ChatAgentRoster[]> {
    const table = schema.agentsTable;
    const where = await AgentModel.buildRosterWhere(params);
    const fallbackBase = await AgentModel.buildRosterWhere({
      ...params,
      options: { ...params.options, excludeOtherPersonalAgents: true },
    });
    const fallbackWhere = and(
      fallbackBase,
      or(not(agentAudienceIs("personal")), eq(table.authorId, params.userId)),
    );
    const first = (condition: SQL | undefined) =>
      db
        .select({ id: table.id })
        .from(table)
        .where(condition)
        .orderBy(desc(table.createdAt), desc(table.id))
        .limit(1);
    const [fallback, system] = await Promise.all([
      (async () => {
        const personal = await first(
          and(
            fallbackWhere,
            eq(table.builtIn, false),
            eq(table.authorId, params.userId),
            agentAudienceIs("personal"),
          ),
        );
        return personal.length > 0
          ? personal
          : first(and(fallbackWhere, eq(table.builtIn, false)));
      })(),
      first(
        and(
          where,
          eq(table.builtIn, true),
          sql`${table.builtInAgentConfig}->>'name' = ${BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG}`,
        ),
      ),
    ]);
    const ids = [...new Set([...fallback, ...system].map((row) => row.id))];
    const rows = await AgentModel.findChatRosterRows(
      and(where, idArrayCondition(table.id, ids)),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  }

  /** Search all permitted chat choices without materializing the full roster. */
  static async findChatRosterPage(params: {
    userId: string;
    isAgentAdmin: boolean;
    options: AgentRosterOptions;
    filters: Pick<AgentOptionFilters, "search"> & {
      sortBy?: "createdAt" | "name" | "chat";
    };
    pagination: CursorQuery;
  }) {
    const table = schema.agentsTable;
    const base = await AgentModel.buildRosterWhere({
      ...params,
      options: { ...params.options, excludeOtherPersonalAgents: false },
    });
    const pattern = params.filters.search
      ? `%${escapeLikePattern(params.filters.search)}%`
      : undefined;
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    // Only object-local read grants determine scope. Classify their scopes as
    // one set instead of probing each agent's policy to discard other authors'
    // personal agents; the base query still enforces all read permissions.
    const nonPersonalReaders = ["organization", "role", "team"].map(
      (type) =>
        sql`${JSON.stringify([{ subject: { type }, actions: ["read"] }])}`,
    );
    const nonPersonalAudience = sql<boolean>`(${table.organizationId}, ${table.id}::text) IN (
      SELECT chat_policy.organization_id, chat_policy.scope
      FROM resource_permission_policies chat_policy
      WHERE chat_policy.resource = 'agent' AND chat_policy.scope <> '*'
        ${params.options.authorization ? sql`AND chat_policy.organization_id = ${params.options.authorization.organizationId}` : sql``}
        AND chat_policy.grants @> ANY(ARRAY[${sql.join(nonPersonalReaders, sql`, `)}]::jsonb[])
    )`;
    // SPDX-SnippetEnd
    const where = and(
      base,
      or(eq(table.authorId, params.userId), nonPersonalAudience),
      eq(table.builtIn, false),
      pattern
        ? or(ilike(table.name, pattern), ilike(table.description, pattern))
        : undefined,
    );
    const page = await AgentModel.findRosterPageIds({
      where,
      sortBy: params.filters.sortBy ?? "chat",
      pagination: params.pagination,
    });
    const rows = await AgentModel.findChatRosterRows(
      and(
        base,
        idArrayCondition(
          table.id,
          page.data.map((row) => row.id),
        ),
      ),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    return {
      data: page.data.flatMap((row) => {
        const agent = byId.get(row.id);
        return agent ? [agent] : [];
      }),
      pagination: page.pagination,
    };
  }

  /** Authorize and bound selector rows before loading any presentation relations. */
  static async findOptionsPage(params: {
    userId: string;
    isAgentAdmin: boolean;
    options: AgentRosterOptions;
    filters: AgentOptionFilters;
    pagination: CursorQuery;
  }) {
    const { where, rosterWhere } = await AgentModel.buildOptionWhere(params);
    const table = schema.agentsTable;
    const page = await AgentModel.findRosterPageIds({
      where,
      sortBy: params.filters.sortBy,
      pagination: params.pagination,
    });
    const options = await AgentModel.findOptionRows(
      and(
        rosterWhere,
        idArrayCondition(
          table.id,
          page.data.map((row) => row.id),
        ),
      ),
    );
    const byId = new Map(options.map((option) => [option.id, option]));
    return {
      data: page.data.flatMap((row) => {
        const option = byId.get(row.id);
        return option ? [option] : [];
      }),
      pagination: page.pagination,
    };
  }

  /** Complete IDs for an explicit select-all action, without hydrating metadata. */
  static async findOptionIds(params: {
    userId: string;
    isAgentAdmin: boolean;
    options: AgentRosterOptions;
    filters: AgentOptionFilters;
  }): Promise<string[]> {
    const { where } = await AgentModel.buildOptionWhere(params);
    const table = schema.agentsTable;
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(where)
      .orderBy(desc(table.createdAt), desc(table.id));
    return rows.map((row) => row.id);
  }

  /** Find all agents with optional filtering by agent type. */
  static async findAll(
    userId?: string,
    isAgentAdmin?: boolean,
    options?: AgentRosterOptions & { view?: "chat" },
  ): Promise<Agent[]>;
  static async findAll(
    userId: string | undefined,
    isAgentAdmin: boolean | undefined,
    options: AgentRosterOptions & { view: "options" },
  ): Promise<AgentOption[]>;
  static async findAll(
    userId?: string,
    isAgentAdmin?: boolean,
    options?: AgentRosterOptions,
  ): Promise<Agent[] | AgentOption[]>;
  static async findAll(
    userId?: string,
    isAgentAdmin?: boolean,
    options?: AgentRosterOptions,
  ): Promise<Agent[] | AgentOption[]> {
    // Tools are attached afterwards as slim refs via one batched query:
    // joining them here multiplied every agent row (system prompt included)
    // by that agent's tool count.
    const where = await AgentModel.buildRosterWhere({
      userId,
      isAgentAdmin,
      options,
    });
    const isChatView = options?.view === "chat";
    const isOptionsView = options?.view === "options";
    const isCompactView = isChatView || isOptionsView;
    if (isOptionsView) return AgentModel.findOptionRows(where);
    const rows = isCompactView
      ? await db
          .select(CHAT_AGENT_ROW_COLUMNS)
          .from(schema.agentsTable)
          .where(where)
      : await db.select().from(schema.agentsTable).where(where);

    const agents: Agent[] = rows.map((agent) => ({
      ...agent,
      tools: [],
      teams: [] as Array<{ id: string; name: string }>,
      users: [] as Array<{ id: string; name: string; email: string }>,
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
      suggestedPrompts: [],
    }));
    const agentIds = agents.map((agent) => agent.id);

    // Populate tools, teams, and labels for all agents with bulk queries to
    // avoid N+1. Chat starts from scalar configuration plus a few small
    // relation lists; editing fetches the individual full agent on demand.
    const [toolRows, teamsMap, usersMap, labelsMap] = await Promise.all([
      agentIds.length > 0 && options?.includeTools !== false && !isCompactView
        ? db
            .select({
              agentId: schema.agentToolsTable.agentId,
              tool: agentToolRefColumns,
            })
            .from(schema.agentToolsTable)
            .innerJoin(
              schema.toolsTable,
              eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
            )
            .where(idArrayCondition(schema.agentToolsTable.agentId, agentIds))
        : Promise.resolve([]),
      isChatView
        ? Promise.resolve(new Map())
        : AgentTeamModel.getTeamDetailsForAgents(agentIds),
      isChatView
        ? Promise.resolve(new Map())
        : AgentUserModel.getUserDetailsForAgents(agentIds),
      isCompactView
        ? Promise.resolve(new Map())
        : AgentLabelModel.getLabelsForAgents(agentIds),
    ]);

    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    for (const row of toolRows) {
      agentsById.get(row.agentId)?.tools.push(row.tool);
    }

    // Assign teams, grantees, and labels to each agent
    for (const agent of agents) {
      agent.teams = teamsMap.get(agent.id) || [];
      agent.users = usersMap.get(agent.id) || [];
      agent.labels = labelsMap.get(agent.id) || [];
    }

    await Promise.all([
      AgentModel.populateGrantedScope(agents),
      isChatView ? Promise.resolve() : AgentModel.populateAuthorNames(agents),
      isOptionsView
        ? Promise.resolve()
        : AgentModel.populateKnowledgeBaseIds(agents),
      isOptionsView
        ? Promise.resolve()
        : AgentModel.populateConnectorIds(agents),
      isOptionsView
        ? Promise.resolve()
        : AgentModel.populateSuggestedPrompts(agents),
      isOptionsView
        ? Promise.resolve()
        : AgentModel.populateResolvedLlm(agents),
    ]);
    AgentModel.filterUnavailableKnowledgeTools(agents);

    return agents;
  }

  /** The delegation canvas needs nodes, not editable agents or their assigned tools. */
  static async findDelegationGraphNodes(organizationId: string) {
    const table = schema.agentsTable;
    return db
      .select({ id: table.id, name: table.name, agentType: table.agentType })
      .from(table)
      .where(
        and(
          eq(table.organizationId, organizationId),
          eq(table.agentType, "agent"),
          notDeleted(table),
        ),
      )
      .orderBy(desc(table.createdAt), desc(table.id));
  }

  /**
   * Find all agents for an organization with optional filtering by agentType
   */
  static async findByOrganizationId(
    organizationId: string,
    options?: { agentType?: AgentType },
  ): Promise<Agent[]> {
    const whereConditions: SQL[] = [
      eq(schema.agentsTable.organizationId, organizationId),
      notDeleted(schema.agentsTable),
    ];

    if (options?.agentType !== undefined) {
      whereConditions.push(eq(schema.agentsTable.agentType, options.agentType));
    }

    const agents = await db
      .select()
      .from(schema.agentsTable)
      .where(and(...whereConditions))
      .orderBy(desc(schema.agentsTable.createdAt), desc(schema.agentsTable.id));

    // Get tools, teams, and labels for all agents
    const agentIds = agents.map((a) => a.id);

    if (agentIds.length === 0) {
      return [];
    }

    const [
      teamsMap,
      usersMap,
      labelsMap,
      kbMap,
      connectorMap,
      suggestedPromptsMap,
      toolsResult,
    ] = await Promise.all([
      AgentTeamModel.getTeamDetailsForAgents(agentIds),
      AgentUserModel.getUserDetailsForAgents(agentIds),
      AgentLabelModel.getLabelsForAgents(agentIds),
      AgentKnowledgeBaseModel.getKnowledgeBaseIdsForAgents(agentIds),
      AgentConnectorAssignmentModel.getConnectorIdsForAgents(agentIds),
      AgentSuggestedPromptModel.getForAgents(agentIds),
      db
        .select({
          agentId: schema.agentToolsTable.agentId,
          tool: agentToolRefColumns,
        })
        .from(schema.agentToolsTable)
        .innerJoin(
          schema.toolsTable,
          eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
        )
        .where(idArrayCondition(schema.agentToolsTable.agentId, agentIds)),
    ]);

    // Group tools by agent
    const toolsByAgent = new Map<string, AgentToolRef[]>();
    for (const row of toolsResult) {
      const existing = toolsByAgent.get(row.agentId) || [];
      existing.push(row.tool);
      toolsByAgent.set(row.agentId, existing);
    }

    const results = agents.map((agent) => ({
      ...agent,
      tools: toolsByAgent.get(agent.id) || [],
      teams: teamsMap.get(agent.id) || [],
      users: usersMap.get(agent.id) || [],
      labels: labelsMap.get(agent.id) || [],
      knowledgeBaseIds: kbMap.get(agent.id) || [],
      connectorIds: connectorMap.get(agent.id) || [],
      suggestedPrompts: suggestedPromptsMap.get(agent.id) || [],
    }));
    await AgentModel.populateGrantedScope(results);
    await AgentModel.populateResolvedLlm(results);
    AgentModel.filterUnavailableKnowledgeTools(results);

    return results;
  }

  /**
   * Runtime Agents run since `since`, most recently run first. The warm pool
   * reconciler takes distinct configurations from the top, so its limited
   * pools follow the Agents people actually use.
   */
  static async listWarmPoolCandidates(params: { since: Date }) {
    const recentRuns = db
      .select({
        agentId: schema.agentRunsTable.agentId,
        lastRunAt: max(schema.agentRunsTable.startedAt).as("last_run_at"),
      })
      .from(schema.agentRunsTable)
      .where(gte(schema.agentRunsTable.startedAt, params.since))
      .groupBy(schema.agentRunsTable.agentId)
      .as("recent_runs");
    return db
      .select({
        id: schema.agentsTable.id,
        organizationId: schema.agentsTable.organizationId,
        environmentId: schema.agentsTable.environmentId,
        runtime: schema.agentsTable.runtime,
        namespace: schema.environmentsTable.namespace,
        defaultNamespace: schema.organizationsTable.defaultEnvironmentNamespace,
        environmentPolicy: schema.environmentsTable.networkPolicy,
        defaultPolicy: schema.organizationsTable.defaultNetworkPolicy,
      })
      .from(schema.agentsTable)
      .innerJoin(recentRuns, eq(recentRuns.agentId, schema.agentsTable.id))
      .innerJoin(
        schema.organizationsTable,
        eq(schema.organizationsTable.id, schema.agentsTable.organizationId),
      )
      .leftJoin(
        schema.environmentsTable,
        and(
          eq(schema.environmentsTable.id, schema.agentsTable.environmentId),
          eq(
            schema.environmentsTable.organizationId,
            schema.agentsTable.organizationId,
          ),
        ),
      )
      .where(
        and(
          isNotNull(schema.agentsTable.runtime),
          notDeleted(schema.agentsTable),
        ),
      )
      .orderBy(desc(recentRuns.lastRunAt), schema.agentsTable.id);
  }

  /**
   * Runtime Agents without an explicit model/key pair inherit the
   * organization's effective default model. This narrow query supports
   * validating a proposed default without loading each Agent's relations.
   */
  static async findRuntimeAgentsInheritingOrganizationDefault(
    organizationId: string,
  ): Promise<Array<Pick<Agent, "id" | "name" | "runtime">>> {
    return db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        runtime: schema.agentsTable.runtime,
      })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.organizationId, organizationId),
          isNull(schema.agentsTable.llmApiKeyId),
          isNull(schema.agentsTable.modelId),
          isNotNull(schema.agentsTable.runtime),
          notDeleted(schema.agentsTable),
        ),
      );
  }

  static async findRuntimeTargets(organizationId: string) {
    return db
      .select({ id: schema.agentsTable.id, name: schema.agentsTable.name })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.organizationId, organizationId),
          isNotNull(schema.agentsTable.runtime),
          notDeleted(schema.agentsTable),
        ),
      );
  }

  /** Agents a delegation call starts as an OpenAPPA child: the organization's own, built-ins excluded. */
  static async findSpawnTargets(organizationId: string) {
    return db
      .select({ id: schema.agentsTable.id, name: schema.agentsTable.name })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.organizationId, organizationId),
          eq(schema.agentsTable.agentType, "agent"),
          eq(schema.agentsTable.builtIn, false),
          notDeleted(schema.agentsTable),
        ),
      );
  }

  /**
   * Find all agents for an organization filtered by accessible agent IDs
   * Returns only agents the user has access to via team membership
   */
  static async findByOrganizationIdAndAccessibleTeams(
    organizationId: string,
    accessibleAgentIds: string[],
    options?: { agentType?: AgentType },
  ): Promise<Agent[]> {
    if (accessibleAgentIds.length === 0) {
      return [];
    }

    const whereConditions: SQL[] = [
      eq(schema.agentsTable.organizationId, organizationId),
      inArray(schema.agentsTable.id, accessibleAgentIds),
      notDeleted(schema.agentsTable),
    ];

    if (options?.agentType !== undefined) {
      whereConditions.push(eq(schema.agentsTable.agentType, options.agentType));
    }

    const agents = await db
      .select()
      .from(schema.agentsTable)
      .where(and(...whereConditions))
      .orderBy(desc(schema.agentsTable.createdAt), desc(schema.agentsTable.id));

    const agentIds = agents.map((a) => a.id);

    if (agentIds.length === 0) {
      return [];
    }

    const [
      teamsMap,
      usersMap,
      labelsMap,
      kbMap,
      connectorMap,
      suggestedPromptsMap,
      toolsResult,
    ] = await Promise.all([
      AgentTeamModel.getTeamDetailsForAgents(agentIds),
      AgentUserModel.getUserDetailsForAgents(agentIds),
      AgentLabelModel.getLabelsForAgents(agentIds),
      AgentKnowledgeBaseModel.getKnowledgeBaseIdsForAgents(agentIds),
      AgentConnectorAssignmentModel.getConnectorIdsForAgents(agentIds),
      AgentSuggestedPromptModel.getForAgents(agentIds),
      db
        .select({
          agentId: schema.agentToolsTable.agentId,
          tool: agentToolRefColumns,
        })
        .from(schema.agentToolsTable)
        .innerJoin(
          schema.toolsTable,
          eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
        )
        .where(idArrayCondition(schema.agentToolsTable.agentId, agentIds)),
    ]);

    // Group tools by agent
    const toolsByAgent = new Map<string, AgentToolRef[]>();
    for (const row of toolsResult) {
      const existing = toolsByAgent.get(row.agentId) || [];
      existing.push(row.tool);
      toolsByAgent.set(row.agentId, existing);
    }

    const results = agents.map((agent) => ({
      ...agent,
      tools: toolsByAgent.get(agent.id) || [],
      teams: teamsMap.get(agent.id) || [],
      users: usersMap.get(agent.id) || [],
      labels: labelsMap.get(agent.id) || [],
      knowledgeBaseIds: kbMap.get(agent.id) || [],
      connectorIds: connectorMap.get(agent.id) || [],
      suggestedPrompts: suggestedPromptsMap.get(agent.id) || [],
    }));
    await AgentModel.populateGrantedScope(results);
    await AgentModel.populateResolvedLlm(results);
    AgentModel.filterUnavailableKnowledgeTools(results);

    return results;
  }

  /**
   * Candidates for the A2A registry: every internal agent in the organization
   * that could have an Agent Card, with only the fields a card needs.
   *
   * This is deliberately *not* an authorization query. It answers "which
   * agents belong in the catalog", and the caller then runs the ordinary
   * per-agent gateway check against each one. Keeping the two apart means the
   * registry cannot disagree with what a direct card fetch would allow.
   *
   * Built-in agents are left out: title generation and context compaction are
   * machinery this platform runs on, not collaborators
   * anyone would address over A2A. Personal agents stay in — one belongs to
   * somebody, and the per-agent check decides whether that is the caller.
   */
  static async findA2ARegistryCandidates(
    organizationId: string,
  ): Promise<
    Pick<Agent, "id" | "name" | "description" | "systemPrompt" | "updatedAt">[]
  > {
    return db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        description: schema.agentsTable.description,
        systemPrompt: schema.agentsTable.systemPrompt,
        updatedAt: schema.agentsTable.updatedAt,
      })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.organizationId, organizationId),
          eq(schema.agentsTable.agentType, "agent"),
          eq(schema.agentsTable.builtIn, false),
          notDeleted(schema.agentsTable),
        ),
      )
      .orderBy(asc(schema.agentsTable.name));
  }

  /**
   * Internal agents (not built-in) the user can use, for the agent picker in
   * Teams/Slack/etc. A channel is shared, so it leaves personal agents out. A
   * direct message is the user's own, so it keeps them.
   */
  static async findUsableChatopsAgents(params: {
    organizationId: string;
    userId: string;
    includePersonal: boolean;
  }) {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    const principal =
      await ResourcePermissionSubjectModel.resolvePrincipal(params);
    return db
      .select({ id: schema.agentsTable.id, name: schema.agentsTable.name })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.organizationId, params.organizationId),
          eq(schema.agentsTable.agentType, "agent"),
          eq(schema.agentsTable.builtIn, false),
          notDeleted(schema.agentsTable),
          ResourcePermissionPolicyModel.grantCondition({
            ...principal,
            resource: "agent",
            scopeColumn: schema.agentsTable.id,
            action: "use",
          }),
          // Like the agents page without admin access: an admin can use
          // every agent, but pickers offer only theirs and those shared
          // with them or the organization.
          ResourcePermissionPolicyModel.accessRelationCondition({
            organizationId: schema.agentsTable.organizationId,
            resource: "agent",
            scopeColumn: schema.agentsTable.id,
            ownerColumn: schema.agentsTable.authorId,
            userId: params.userId,
            subjects: principal.subjects,
            relations: ["mine", "shared", "org"],
          }),
          params.includePersonal ? undefined : not(agentAudienceIs("personal")),
        ),
      )
      .orderBy(asc(schema.agentsTable.name));
    // SPDX-SnippetEnd
  }

  static async findAllInternalAgents(): Promise<
    Pick<Agent, "id" | "name" | "scope" | "authorId">[]
  > {
    const agents = await db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        scope: schema.agentsTable.scope,
        authorId: schema.agentsTable.authorId,
        createdByServiceAccountId: schema.agentsTable.createdByServiceAccountId,
      })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.agentType, "agent"),
          eq(schema.agentsTable.builtIn, false),
          not(agentAudienceIs("personal")),
          notDeleted(schema.agentsTable),
        ),
      )
      .orderBy(asc(schema.agentsTable.name));

    return agents;
  }

  /**
   * Find all internal agents including personal ones authored by a specific user.
   * Used for DM agent selection where personal agents of the current user are allowed.
   */
  static async findAllInternalAgentsIncludingPersonal(
    userId: string,
  ): Promise<Pick<Agent, "id" | "name" | "scope" | "authorId">[]> {
    const agents = await db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        scope: schema.agentsTable.scope,
        authorId: schema.agentsTable.authorId,
        createdByServiceAccountId: schema.agentsTable.createdByServiceAccountId,
      })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.agentType, "agent"),
          eq(schema.agentsTable.builtIn, false),
          or(
            not(agentAudienceIs("personal")),
            eq(schema.agentsTable.authorId, userId),
          ),
          notDeleted(schema.agentsTable),
        ),
      )
      .orderBy(asc(schema.agentsTable.name));

    return agents;
  }

  /**
   * Return globally sorted references for the dedicated Agents-page catalog.
   * Full rows are hydrated only after pagination chooses the winning ids.
   */
  static async findCatalogCandidates(params: {
    pagination: PaginationQuery;
    sorting?: SortingQuery;
    filters?: AgentListFilters;
    userId: string;
    isAgentAdmin: boolean;
    /**
     * The grant an external agent row needs. A bulk selection asks for
     * `delete`, the only bulk action, so it lists only rows it can act on.
     */
    externalAgentAction?: "read" | "delete";
    excludeOtherPersonalExternalAgents?: boolean;
  }): Promise<AgentCatalogCandidatePage> {
    const regularWhereClause = await AgentModel.buildListWhereClause({
      filters: {
        ...params.filters,
        agentTypes: ["agent"],
      },
      userId: params.userId,
      isAgentAdmin: params.isAgentAdmin,
    });
    const regularAccessCandidates = await catalogAccessCandidateIds({
      organizationId: params.filters?.organizationId,
      userId: params.userId,
      selection: params.filters?.access,
      includeBuiltIn:
        params.filters?.includeBuiltIn === true &&
        params.isAgentAdmin &&
        !params.filters?.scope,
    });
    const includeExternalAgents =
      (params.filters?.status ?? "active") === "active" &&
      !params.filters?.labels &&
      !params.filters?.providerApiKeyId &&
      params.filters?.pinned !== true &&
      params.filters?.scope !== "built_in";
    const externalWhereConditions: SQL[] = [
      includeExternalAgents
        ? eq(
            schema.a2aRemoteAgentsTable.organizationId,
            params.filters?.organizationId ?? "",
          )
        : sql<boolean>`false`,
    ];

    if (params.filters?.name) {
      externalWhereConditions.push(
        ilike(
          schema.a2aRemoteAgentsTable.name,
          `%${escapeLikePattern(params.filters.name)}%`,
        ),
      );
    }
    if (
      params.filters?.scope === "personal" ||
      params.filters?.scope === "team" ||
      params.filters?.scope === "org"
    ) {
      externalWhereConditions.push(
        externalAgentAudienceIs(params.filters.scope),
      );
    }
    if (params.filters?.teamIds?.length) {
      externalWhereConditions.push(
        ResourcePermissionPolicyModel.grantsReadToAnyTeam({
          organizationId: schema.a2aRemoteAgentsTable.organizationId,
          resource: "externalAgent",
          scopeColumn: schema.a2aRemoteAgentsTable.id,
          teamIds: params.filters.teamIds,
        }),
      );
    }
    if (params.filters?.authorIds?.length) {
      externalWhereConditions.push(
        inArray(schema.a2aRemoteAgentsTable.authorId, params.filters.authorIds),
      );
    }
    if (params.filters?.ids) {
      externalWhereConditions.push(
        params.filters.ids.length > 0
          ? inArray(schema.a2aRemoteAgentsTable.id, params.filters.ids)
          : sql<boolean>`false`,
      );
    }
    if (params.filters?.excludeIds?.length) {
      externalWhereConditions.push(
        notInArray(schema.a2aRemoteAgentsTable.id, params.filters.excludeIds),
      );
    }
    if (params.filters?.excludeAuthorIds?.length) {
      const excludeAuthorsCondition = or(
        isNull(schema.a2aRemoteAgentsTable.authorId),
        notInArray(
          schema.a2aRemoteAgentsTable.authorId,
          params.filters.excludeAuthorIds,
        ),
      );
      if (excludeAuthorsCondition) {
        externalWhereConditions.push(excludeAuthorsCondition);
      }
    }
    if (params.filters?.access) {
      const externalAccessCondition = await externalAgentAccessCondition({
        userId: params.userId,
        organizationId: params.filters.organizationId,
        selection: params.filters.access,
      });
      if (externalAccessCondition)
        externalWhereConditions.push(externalAccessCondition);
    }
    if (params.excludeOtherPersonalExternalAgents) {
      const ownPersonalOnlyCondition = or(
        not(externalAgentAudienceIs("personal")),
        eq(schema.a2aRemoteAgentsTable.authorId, params.userId),
      );
      if (ownPersonalOnlyCondition) {
        externalWhereConditions.push(ownPersonalOnlyCondition);
      }
    }
    externalWhereConditions.push(
      await A2aRemoteAgentModel.accessCondition({
        organizationId: params.filters?.organizationId ?? "",
        userId: params.userId,
        action: params.externalAgentAction ?? "read",
      }),
    );
    externalWhereConditions.push(
      exists(
        db
          .select({ value: sql`1` })
          .from(schema.a2aConnectionsTable)
          .innerJoin(
            schema.toolsTable,
            eq(
              schema.toolsTable.delegateToA2aConnectionId,
              schema.a2aConnectionsTable.id,
            ),
          )
          .where(
            eq(
              schema.a2aConnectionsTable.remoteAgentId,
              schema.a2aRemoteAgentsTable.id,
            ),
          ),
      ),
    );

    const { regular: regularSortValue, external: externalSortValue } =
      catalogSortValue(params.sorting?.sortBy);
    const regularCandidates = db
      .select({
        resourceType: sql<"agent" | "external">`'agent'`.as("resource_type"),
        sortValue: regularSortValue.as("sort_value"),
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        createdAt: schema.agentsTable.createdAt,
        teamName: sql<string>`COALESCE(${agentFirstGrantedTeamName()}, '')`.as(
          "team_name",
        ),
        // The author test is cheap and rejects nearly every row, so it runs
        // before the policy probe.
        personalPriority: sql<number>`CASE
          WHEN ${schema.agentsTable.authorId} = ${params.userId}
            AND ${agentAudienceIs("personal")}
          THEN 0 ELSE 1 END`.as("personal_priority"),
        pinnedAt: sql<Date | null>`(
          SELECT ${schema.agentPinsTable.pinnedAt}
          FROM ${schema.agentPinsTable}
          WHERE ${schema.agentPinsTable.userId} = ${params.userId}
            AND ${schema.agentPinsTable.agentId} = ${schema.agentsTable.id}
        )`.as("pinned_at"),
      })
      .from(schema.agentsTable)
      .where(and(regularWhereClause, regularAccessCandidates));
    const externalCandidates = db
      .select({
        resourceType: sql<"agent" | "external">`'external'`.as("resource_type"),
        sortValue: externalSortValue.as("sort_value"),
        id: schema.a2aRemoteAgentsTable.id,
        name: schema.a2aRemoteAgentsTable.name,
        createdAt: schema.a2aRemoteAgentsTable.createdAt,
        teamName:
          sql<string>`COALESCE(${externalAgentFirstGrantedTeamName()}, '')`.as(
            "team_name",
          ),
        personalPriority: sql<number>`CASE
          WHEN ${externalAgentAudienceIs("personal")}
            AND ${schema.a2aRemoteAgentsTable.authorId} = ${params.userId}
          THEN 0 ELSE 1 END`.as("personal_priority"),
        pinnedAt: sql<Date | null>`NULL::timestamp`.as("pinned_at"),
      })
      .from(schema.a2aRemoteAgentsTable)
      .where(and(...externalWhereConditions));
    const candidates = unionAll(regularCandidates, externalCandidates).as(
      "agent_catalog_candidates",
    );
    const direction = params.sorting?.sortDirection === "asc" ? asc : desc;
    const sortColumn =
      params.sorting?.sortBy === "name"
        ? candidates.name
        : params.sorting?.sortBy === "team"
          ? candidates.teamName
          : params.sorting?.sortBy &&
              CATALOG_COMPUTED_SORTS.has(params.sorting.sortBy)
            ? candidates.sortValue
            : candidates.createdAt;

    // The caller's own personal agents lead the default order. A column the
    // caller sorts by orders the whole list, or "Last used" would show the
    // most recent agent below every one of theirs.
    const isDefaultOrder =
      params.sorting?.sortBy === undefined ||
      params.sorting.sortBy === "createdAt";
    const candidateOrder =
      params.filters?.pinned === true
        ? [desc(candidates.pinnedAt), asc(candidates.name), asc(candidates.id)]
        : [
            ...(isDefaultOrder ? [asc(candidates.personalPriority)] : []),
            direction(sortColumn),
            asc(candidates.name),
            asc(candidates.resourceType),
            asc(candidates.id),
          ];

    // The totals ride on the page as window counts, so the candidate set,
    // with its per-row authorization, is built once per request.
    const page = await db
      .select({
        type: candidates.resourceType,
        id: candidates.id,
        total: sql<number>`COUNT(*) OVER ()`,
        agentTotal: sql<number>`COUNT(*) FILTER (WHERE ${candidates.resourceType} = 'agent') OVER ()`,
        externalAgentTotal: sql<number>`COUNT(*) FILTER (WHERE ${candidates.resourceType} = 'external') OVER ()`,
      })
      .from(candidates)
      .orderBy(...candidateOrder)
      .limit(params.pagination.limit)
      .offset(params.pagination.offset);
    // A page past the end has no row to carry the totals.
    const [totals] =
      page.length > 0 || params.pagination.offset === 0
        ? page
        : await db
            .select({
              total: count(),
              agentTotal: sql<number>`COUNT(*) FILTER (WHERE ${candidates.resourceType} = 'agent')`,
              externalAgentTotal: sql<number>`COUNT(*) FILTER (WHERE ${candidates.resourceType} = 'external')`,
            })
            .from(candidates);

    return {
      rows: page.map(({ type, id }) => ({ type, id })),
      total: Number(totals?.total ?? 0),
      agentTotal: Number(totals?.agentTotal ?? 0),
      externalAgentTotal: Number(totals?.externalAgentTotal ?? 0),
    };
  }

  /**
   * Find all agents with pagination, sorting, and filtering support
   */
  static async findAllPaginated(
    pagination: PaginationQuery,
    sorting?: SortingQuery,
    filters?: AgentListFilters,
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<PaginatedResult<AgentListItem>> {
    // Determine the ORDER BY clause based on sorting params
    const orderByClause = AgentModel.getOrderByClause(sorting);
    const personalAgentPriorityOrderClauses =
      AgentModel.getPersonalAgentPriorityOrderClauses(userId);
    if (filters?.pinned !== undefined && !userId) {
      return createPaginatedResult([], 0, pagination);
    }
    const pinnedAgentOrderClauses =
      filters?.pinned === true && userId
        ? [
            desc(sql`(
              SELECT ${schema.agentPinsTable.pinnedAt}
              FROM ${schema.agentPinsTable}
              WHERE ${schema.agentPinsTable.userId} = ${userId}
                AND ${schema.agentPinsTable.agentId} = ${schema.agentsTable.id}
            )`),
          ]
        : [];

    const whereClause = await AgentModel.buildListWhereClause({
      filters,
      userId,
      isAgentAdmin,
    });

    // Step 1: Get paginated agent IDs with proper sorting
    // This ensures LIMIT/OFFSET applies to agents, not to joined rows with tools
    let query = db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(whereClause)
      .$dynamic();

    const direction = sorting?.sortDirection === "asc" ? asc : desc;

    // Add sorting-specific joins and order by
    if (sorting?.sortBy === "subagentsCount") {
      const subagentsCountSubquery = db
        .select({
          agentId: schema.agentToolsTable.agentId,
          subagentsCount: count(schema.agentToolsTable.toolId).as(
            "subagentsCount",
          ),
        })
        .from(schema.agentToolsTable)
        .innerJoin(
          schema.toolsTable,
          eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
        )
        .where(sql`${schema.toolsTable.delegateToAgentId} IS NOT NULL`)
        .groupBy(schema.agentToolsTable.agentId)
        .as("subagentsCounts");

      query = query
        .leftJoin(
          subagentsCountSubquery,
          eq(schema.agentsTable.id, subagentsCountSubquery.agentId),
        )
        .orderBy(
          ...pinnedAgentOrderClauses,
          ...personalAgentPriorityOrderClauses,
          direction(sql`COALESCE(${subagentsCountSubquery.subagentsCount}, 0)`),
        );
    } else if (sorting?.sortBy === "toolsCount") {
      const toolsCountSubquery = db
        .select({
          agentId: schema.agentToolsTable.agentId,
          toolsCount: count(schema.agentToolsTable.toolId).as("toolsCount"),
        })
        .from(schema.agentToolsTable)
        .groupBy(schema.agentToolsTable.agentId)
        .as("toolsCounts");

      query = query
        .leftJoin(
          toolsCountSubquery,
          eq(schema.agentsTable.id, toolsCountSubquery.agentId),
        )
        .orderBy(
          ...pinnedAgentOrderClauses,
          ...personalAgentPriorityOrderClauses,
          direction(sql`COALESCE(${toolsCountSubquery.toolsCount}, 0)`),
        );
    } else if (sorting?.sortBy === "knowledgeSourcesCount") {
      const knowledgeSourcesCountSubquery = db
        .select({
          agentId: schema.agentsTable.id,
          knowledgeSourcesCount:
            sql<number>`(SELECT COUNT(*) FROM agent_knowledge_base WHERE agent_id = ${schema.agentsTable.id}) + (SELECT COUNT(*) FROM agent_connector_assignment WHERE agent_id = ${schema.agentsTable.id})`.as(
              "knowledgeSourcesCount",
            ),
        })
        .from(schema.agentsTable)
        .as("knowledgeSourcesCounts");

      query = query
        .leftJoin(
          knowledgeSourcesCountSubquery,
          eq(schema.agentsTable.id, knowledgeSourcesCountSubquery.agentId),
        )
        .orderBy(
          ...pinnedAgentOrderClauses,
          ...personalAgentPriorityOrderClauses,
          direction(
            sql`COALESCE(${knowledgeSourcesCountSubquery.knowledgeSourcesCount}, 0)`,
          ),
        );
    } else if (sorting?.sortBy === "lastUsedAt") {
      const lastUsedAtSubquery = db
        .select({
          agentId: schema.mcpToolCallsTable.agentId,
          lastUsedAt: max(schema.mcpToolCallsTable.createdAt).as("lastUsedAt"),
        })
        .from(schema.mcpToolCallsTable)
        .groupBy(schema.mcpToolCallsTable.agentId)
        .as("lastUsedAts");

      /**
       * The LLM-call half of "last used", correlated rather than aggregated:
       * an unfiltered `GROUP BY profile_id` here would aggregate the whole of
       * `interactions` — the platform's largest table — on every sorted list
       * request. Correlating it instead costs one backward scan of
       * `(profile_id, created_at DESC)` per candidate agent, and agents number
       * in the hundreds.
       */
      const lastInteractionAt = sql`(
        SELECT max(${schema.interactionsTable.createdAt})
        FROM ${schema.interactionsTable}
        WHERE ${schema.interactionsTable.profileId} = ${schema.agentsTable.id}
      )`;

      query = query
        .leftJoin(
          lastUsedAtSubquery,
          eq(schema.agentsTable.id, lastUsedAtSubquery.agentId),
        )
        .orderBy(
          ...pinnedAgentOrderClauses,
          ...personalAgentPriorityOrderClauses,
          // Ordered by the same value the row displays: the later of the two
          // signals. Never-used agents sort as oldest (asc first / desc last).
          direction(
            sql`GREATEST(
              COALESCE(${lastUsedAtSubquery.lastUsedAt}, '-infinity'::timestamp),
              COALESCE(${lastInteractionAt}, '-infinity'::timestamp)
            )`,
          ),
        );
    } else if (sorting?.sortBy === "team") {
      query = query.orderBy(
        ...pinnedAgentOrderClauses,
        ...personalAgentPriorityOrderClauses,
        direction(sql`COALESCE(${agentFirstGrantedTeamName()}, '')`),
      );
    } else {
      query = query.orderBy(
        ...pinnedAgentOrderClauses,
        ...personalAgentPriorityOrderClauses,
        orderByClause,
      );
    }

    const sortedAgents = await query
      .limit(pagination.limit)
      .offset(pagination.offset);

    const sortedAgentIds = sortedAgents.map((a) => a.id);

    // If no agents match, return early
    if (sortedAgentIds.length === 0) {
      const [{ total }] = await db
        .select({ total: count() })
        .from(schema.agentsTable)
        .where(whereClause);
      return createPaginatedResult([], Number(total), pagination);
    }

    // Step 2: Get full agent data for the paginated agent IDs. Tool refs are
    // a query of their own: joined, every agent row came back once per
    // assigned tool, system prompt and icon included.
    const [agentRows, toolRows, [{ total: totalResult }]] = await Promise.all([
      db
        .select()
        .from(schema.agentsTable)
        .where(inArray(schema.agentsTable.id, sortedAgentIds)),
      filters?.includeTools !== false
        ? db
            .select({
              agentId: schema.agentToolsTable.agentId,
              tool: agentToolRefColumns,
            })
            .from(schema.agentToolsTable)
            .innerJoin(
              schema.toolsTable,
              eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
            )
            .where(inArray(schema.agentToolsTable.agentId, sortedAgentIds))
        : Promise.resolve([]),
      db.select({ total: count() }).from(schema.agentsTable).where(whereClause),
    ]);

    // Sort in memory to maintain the order from the sorted query
    const orderMap = new Map(sortedAgentIds.map((id, index) => [id, index]));
    agentRows.sort(
      (a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0),
    );

    const agents: Agent[] = agentRows.map((agent) => ({
      ...agent,
      tools: [],
      teams: [] as Array<{ id: string; name: string }>,
      users: [] as Array<{ id: string; name: string; email: string }>,
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
      suggestedPrompts: [],
    }));
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    for (const row of toolRows) {
      agentsById.get(row.agentId)?.tools.push(row.tool);
    }
    const agentIds = agents.map((agent) => agent.id);

    // Populate teams and labels for all agents with bulk queries to avoid N+1
    const [teamsMap, usersMap, labelsMap] = await Promise.all([
      AgentTeamModel.getTeamDetailsForAgents(agentIds),
      AgentUserModel.getUserDetailsForAgents(agentIds),
      AgentLabelModel.getLabelsForAgents(agentIds),
    ]);

    // Assign teams, grantees, and labels to each agent
    for (const agent of agents) {
      agent.teams = teamsMap.get(agent.id) || [];
      agent.users = usersMap.get(agent.id) || [];
      agent.labels = labelsMap.get(agent.id) || [];
    }

    await Promise.all([
      AgentModel.populateGrantedScope(agents),
      AgentModel.populateAuthorNames(agents),
      AgentModel.populateKnowledgeBaseIds(agents),
      AgentModel.populateConnectorIds(agents),
      AgentModel.populateSuggestedPrompts(agents),
      AgentModel.populateResolvedLlm(agents),
      AgentModel.populateLastUsedAt(agents),
    ]);
    const pinnedAtByAgent = userId
      ? await AgentPinModel.getPinnedAtForAgents({ userId, agentIds })
      : new Map<string, Date>();
    AgentModel.filterUnavailableKnowledgeTools(agents);

    return createPaginatedResult(
      agents.map((agent) => ({
        ...agent,
        pinnedAt: pinnedAtByAgent.get(agent.id) ?? null,
      })),
      Number(totalResult),
      pagination,
    );
  }

  /**
   * Each listed agent's tool and subagent counts, as its `tools` would give
   * them, without loading the tools: subagents are delegation tools, and the
   * knowledge search tool counts only for an agent with knowledge sources, as
   * in filterUnavailableKnowledgeTools.
   */
  static async getListToolCounts(
    agents: Array<Pick<Agent, "id" | "knowledgeBaseIds" | "connectorIds">>,
  ): Promise<Map<string, { toolsCount: number; subagentsCount: number }>> {
    if (agents.length === 0) return new Map();
    const name = schema.toolsTable.name;
    const delegate = schema.toolsTable.delegateToAgentId;
    // Bare, or after a server prefix of at least one character. The leading
    // `_%` is the only wildcard: the separator and name are escaped and match
    // literally.
    const prefixedKnowledgeTool = `_%${escapeLikePattern(
      `${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME}`,
    )}`;
    const isKnowledgeTool = sql`(${name} = ${TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME} or ${name} like ${prefixedKnowledgeTool})`;
    const rows = await db
      .select({
        agentId: schema.agentToolsTable.agentId,
        tools: sql<number>`count(*) filter (where ${delegate} is null)`.mapWith(
          Number,
        ),
        subagents:
          sql<number>`count(*) filter (where ${delegate} is not null)`.mapWith(
            Number,
          ),
        knowledgeTools:
          sql<number>`count(*) filter (where ${delegate} is null and ${isKnowledgeTool})`.mapWith(
            Number,
          ),
      })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .where(
        inArray(
          schema.agentToolsTable.agentId,
          agents.map((agent) => agent.id),
        ),
      )
      .groupBy(schema.agentToolsTable.agentId);
    const countsByAgent = new Map(rows.map((row) => [row.agentId, row]));
    return new Map(
      agents.map((agent) => {
        const counts = countsByAgent.get(agent.id);
        return [
          agent.id,
          {
            toolsCount:
              (counts?.tools ?? 0) -
              (hasKnowledgeSources(agent) ? 0 : (counts?.knowledgeTools ?? 0)),
            subagentsCount: counts?.subagents ?? 0,
          },
        ];
      }),
    );
  }

  /**
   * Build the regular-agent list predicate shared by the standard endpoint and
   * the Agents-page catalog candidate query.
   */
  private static async buildListWhereClause(params: {
    filters?: AgentListFilters;
    userId?: string;
    isAgentAdmin?: boolean;
  }): Promise<SQL | undefined> {
    const { filters, userId, isAgentAdmin } = params;
    const principals = userId
      ? await ResourcePermissionSubjectModel.resolvePrincipals({
          userId,
          organizationId:
            filters?.authorization?.organizationId ?? filters?.organizationId,
        })
      : [];
    const whereConditions: SQL[] = [
      getAgentStatusCondition(filters?.status ?? "active"),
      ...(userId ? [agentListFence(principals)] : []),
    ];

    if (filters?.organizationId) {
      whereConditions.push(
        eq(schema.agentsTable.organizationId, filters.organizationId),
      );
    }
    if (filters?.authorization) {
      const { organizationId, baseReadTypes } = filters.authorization;
      whereConditions.push(
        eq(schema.agentsTable.organizationId, organizationId),
      );
      if (!userId) whereConditions.push(sql<boolean>`false`);
      else if (filters.status !== "deleted")
        whereConditions.push(
          or(
            inArray(schema.agentsTable.agentType, baseReadTypes),
            explicitAgentReadCondition(principals),
          ) as SQL,
        );
    }
    if (filters?.ids) {
      whereConditions.push(
        filters.ids.length > 0
          ? inArray(schema.agentsTable.id, filters.ids)
          : sql<boolean>`false`,
      );
    }
    if (filters?.name) {
      whereConditions.push(
        ilike(schema.agentsTable.name, `%${escapeLikePattern(filters.name)}%`),
      );
    }
    if (filters?.providerApiKeyId === "organization-default") {
      whereConditions.push(
        isNull(schema.agentsTable.llmApiKeyId),
        isNull(schema.agentsTable.modelId),
      );
    } else if (filters?.providerApiKeyId) {
      whereConditions.push(
        eq(schema.agentsTable.llmApiKeyId, filters.providerApiKeyId),
      );
    }
    if (filters?.agentTypes?.length) {
      whereConditions.push(
        inArray(schema.agentsTable.agentType, filters.agentTypes),
      );
    } else if (filters?.agentType !== undefined) {
      whereConditions.push(eq(schema.agentsTable.agentType, filters.agentType));
    }

    const includeBuiltIn =
      filters?.includeBuiltIn === true && isAgentAdmin && !filters?.scope;
    const chatAssistant =
      filters?.view === "chat" && enterpriseTier.isOpenappaActive();
    if (filters?.scope === "built_in") {
      whereConditions.push(eq(schema.agentsTable.builtIn, true));
    } else if (
      filters?.scope === "personal" ||
      filters?.scope === "team" ||
      filters?.scope === "org"
    ) {
      whereConditions.push(
        agentAudienceIs(filters.scope),
        eq(schema.agentsTable.builtIn, false),
      );
    } else if (!includeBuiltIn) {
      // Chat selection keeps the system assistant visible to every member; the
      // platform's other built-in agents stay hidden.
      if (chatAssistant) {
        whereConditions.push(
          or(
            eq(schema.agentsTable.builtIn, false),
            eq(
              sql<string>`coalesce(${schema.agentsTable.builtInAgentConfig}->>'name', '')`,
              BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG,
            ),
          ) as SQL,
        );
      } else {
        whereConditions.push(eq(schema.agentsTable.builtIn, false));
      }
    }
    if (!isAgentAdmin && !chatAssistant) {
      whereConditions.push(eq(schema.agentsTable.builtIn, false));
    }
    if (filters?.teamIds?.length) {
      whereConditions.push(agentGrantsReadToAnyTeam(filters.teamIds));
    }
    if (filters?.authorIds?.length) {
      whereConditions.push(
        inArray(schema.agentsTable.authorId, filters.authorIds),
      );
    }
    if (filters?.excludeAuthorIds?.length) {
      const condition = or(
        isNull(schema.agentsTable.authorId),
        notInArray(schema.agentsTable.authorId, filters.excludeAuthorIds),
      );
      if (condition) whereConditions.push(condition);
    }
    if (filters?.excludeIds?.length) {
      whereConditions.push(
        notInArray(schema.agentsTable.id, filters.excludeIds),
      );
    }
    if (filters?.excludeOtherPersonalAgents && userId) {
      whereConditions.push(
        AgentModel.notOthersPersonalCondition({ userId, principals }),
      );
    }
    if (filters?.access && userId) {
      const accessCondition = agentAccessCondition({
        userId,
        principals,
        selection: filters.access,
      });
      if (accessCondition)
        whereConditions.push(
          includeBuiltIn
            ? (or(eq(schema.agentsTable.builtIn, true), accessCondition) as SQL)
            : accessCondition,
        );
    }
    if (filters?.labels) {
      for (const [key, values] of Object.entries(filters.labels)) {
        const agentIdsWithLabel = await db
          .selectDistinct({ agentId: schema.agentLabelsTable.agentId })
          .from(schema.agentLabelsTable)
          .innerJoin(
            schema.labelKeysTable,
            eq(schema.agentLabelsTable.keyId, schema.labelKeysTable.id),
          )
          .innerJoin(
            schema.labelValuesTable,
            eq(schema.agentLabelsTable.valueId, schema.labelValuesTable.id),
          )
          .where(
            and(
              eq(schema.labelKeysTable.key, key),
              inArray(schema.labelValuesTable.value, values),
            ),
          );
        const ids = agentIdsWithLabel.map((row) => row.agentId);
        whereConditions.push(
          ids.length > 0
            ? inArray(schema.agentsTable.id, ids)
            : sql<boolean>`false`,
        );
      }
    }
    if (filters?.pinned !== undefined) {
      if (!userId) {
        whereConditions.push(sql<boolean>`false`);
      } else {
        const pinExists = exists(
          db
            .select({ value: sql`1` })
            .from(schema.agentPinsTable)
            .where(
              and(
                eq(schema.agentPinsTable.userId, userId),
                eq(schema.agentPinsTable.agentId, schema.agentsTable.id),
              ),
            ),
        );
        whereConditions.push(
          filters.pinned ? pinExists : sql`NOT ${pinExists}`,
        );
      }
    }

    // The default active All view remains restricted to rows the caller can
    // reach, even for admins. Explicit scopes and the deleted view retain the
    // existing oversight behavior.
    const isDefaultActiveAllView =
      filters?.scope === undefined &&
      (filters?.status ?? "active") !== "deleted";
    const restrictToAccessible = !isAgentAdmin || isDefaultActiveAllView;
    if (userId && restrictToAccessible) {
      whereConditions.push(
        inArray(
          schema.agentsTable.id,
          accessibleAgentIdsQuery({ userId, isAgentAdmin: false, principals }),
        ),
      );
    }

    return whereConditions.length > 0 ? and(...whereConditions) : undefined;
  }

  /** Get the appropriate ORDER BY clause for the standard agent list. */
  private static getOrderByClause(sorting?: SortingQuery) {
    const direction = sorting?.sortDirection === "asc" ? asc : desc;

    switch (sorting?.sortBy) {
      case "name":
        return direction(schema.agentsTable.name);
      case "createdAt":
        return direction(schema.agentsTable.createdAt);
      case "toolsCount":
      case "subagentsCount":
      case "knowledgeSourcesCount":
      case "team":
      case "lastUsedAt":
        // These sort keys use a separate query path with a dedicated subquery join.
        // This fallback should never be reached for them.
        return direction(schema.agentsTable.createdAt); // Fallback
      default:
        // Default: newest first
        return desc(schema.agentsTable.createdAt);
    }
  }

  private static getPersonalAgentPriorityOrderClauses(userId?: string) {
    if (!userId) {
      return [];
    }

    return [
      asc(sql`
        CASE
          WHEN ${agentAudienceIs("personal")}
            AND ${schema.agentsTable.authorId} = ${userId}
          THEN 0
          ELSE 1
        END
      `),
    ];
  }

  private static filterUnavailableKnowledgeTools(agents: Agent[]): void {
    for (const agent of agents) {
      if (hasKnowledgeSources(agent)) {
        continue;
      }

      agent.tools = agent.tools.filter(
        (tool) => !isQueryKnowledgeSourcesTool(tool.name),
      );
    }
  }

  /**
   * Check if an agent exists without loading related data (teams, labels, tools).
   * Use this for validation to avoid N+1 queries in bulk operations.
   */
  static async exists(id: string): Promise<boolean> {
    const [result] = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(and(eq(schema.agentsTable.id, id), notDeleted(schema.agentsTable)))
      .limit(1);

    return result !== undefined;
  }

  static async existsInOrganization(params: {
    id: string;
    organizationId: string;
  }): Promise<boolean> {
    const [result] = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.id, params.id),
          eq(schema.agentsTable.organizationId, params.organizationId),
          notDeleted(schema.agentsTable),
        ),
      )
      .limit(1);

    return result !== undefined;
  }

  static async findOrganizationId(id: string): Promise<string | null> {
    const [result] = await db
      .select({ organizationId: schema.agentsTable.organizationId })
      .from(schema.agentsTable)
      .where(and(eq(schema.agentsTable.id, id), notDeleted(schema.agentsTable)))
      .limit(1);

    return result?.organizationId ?? null;
  }

  /**
   * Toggle Auto skill mode for the gateway's `skill://` surface.
   *
   * Narrow on purpose: the general `update` carries side effects irrelevant to
   * this flag (delegation-tool sync, exclusion pre-fill) and cannot join a
   * caller's transaction, which this needs so the mode and the assignment set
   * change together.
   */
  static async setAccessAllSkills(
    id: string,
    accessAllSkills: boolean,
    tx?: Transaction,
  ): Promise<void> {
    await (tx ?? db)
      .update(schema.agentsTable)
      .set({ accessAllSkills })
      .where(
        and(eq(schema.agentsTable.id, id), notDeleted(schema.agentsTable)),
      );
  }

  static async setActivationSkillPolicyState(params: {
    id: string;
    mode: AgentActivationSkillMode;
    revision: number;
    tx?: Transaction;
  }): Promise<void> {
    await (params.tx ?? db)
      .update(schema.agentsTable)
      .set({
        activationSkillMode: params.mode,
        activationSkillPolicyRevision: params.revision,
      })
      .where(
        and(
          eq(schema.agentsTable.id, params.id),
          notDeleted(schema.agentsTable),
        ),
      );
  }

  static async findActivationSkillPolicyState(
    id: string,
    tx?: Transaction,
  ): Promise<{
    mode: AgentActivationSkillMode;
    revision: number;
  } | null> {
    const [row] = await (tx ?? db)
      .select({
        mode: schema.agentsTable.activationSkillMode,
        revision: schema.agentsTable.activationSkillPolicyRevision,
      })
      .from(schema.agentsTable)
      .where(and(eq(schema.agentsTable.id, id), notDeleted(schema.agentsTable)))
      .limit(1);
    return row ?? null;
  }

  static async findEnvironmentId(id: string): Promise<string | null> {
    const [result] = await db
      .select({ environmentId: schema.agentsTable.environmentId })
      .from(schema.agentsTable)
      .where(and(eq(schema.agentsTable.id, id), notDeleted(schema.agentsTable)))
      .limit(1);

    return result?.environmentId ?? null;
  }

  /**
   * The two fields that decide whether a caller missing an MCP connection is
   * warned, blocked, or left alone. Kept narrow so the chat turn's pre-flight
   * check costs one indexed row read.
   */
  static async findMissingCredentialEnforcement(
    id: string,
  ): Promise<ReadinessAgent | null> {
    const [result] = await db
      .select({
        id: schema.agentsTable.id,
        missingCredentialBehavior: schema.agentsTable.missingCredentialBehavior,
        accessAllTools: schema.agentsTable.accessAllTools,
      })
      .from(schema.agentsTable)
      .where(and(eq(schema.agentsTable.id, id), notDeleted(schema.agentsTable)))
      .limit(1);

    return result ?? null;
  }

  static async findIdentityProviderId(id: string): Promise<string | null> {
    const [result] = await db
      .select({ identityProviderId: schema.agentsTable.identityProviderId })
      .from(schema.agentsTable)
      .where(and(eq(schema.agentsTable.id, id), notDeleted(schema.agentsTable)))
      .limit(1);

    return result?.identityProviderId ?? null;
  }

  /**
   * Whether the agent's "access all tools" toggle is on — the per-agent opt-in
   * for dynamic tool access via search_tools/run_tool. Lean read on the tool
   * dispatch path; intentionally not cached so toggling the setting affects
   * the next discovery/dispatch call. Defaults to false when the agent is
   * missing or deleted.
   */
  static async getAccessAllTools(id: string): Promise<boolean> {
    const [result] = await db
      .select({ accessAllTools: schema.agentsTable.accessAllTools })
      .from(schema.agentsTable)
      .where(and(eq(schema.agentsTable.id, id), notDeleted(schema.agentsTable)))
      .limit(1);

    return result?.accessAllTools ?? false;
  }

  /**
   * Single-column lookup for the Auto-subagent-mode gate on the delegation
   * dispatch path; intentionally not cached so toggling the setting affects the
   * next delegation call. Defaults to false when the agent is missing/deleted.
   */
  static async getAccessAllSubagents(id: string): Promise<boolean> {
    const [result] = await db
      .select({ accessAllSubagents: schema.agentsTable.accessAllSubagents })
      .from(schema.agentsTable)
      .where(and(eq(schema.agentsTable.id, id), notDeleted(schema.agentsTable)))
      .limit(1);

    return result?.accessAllSubagents ?? false;
  }

  /**
   * Single-column agentType lookup for per-call dispatch gates, avoiding
   * findById's multi-table join. Null when the agent is missing or deleted.
   */
  static async getAgentType(id: string): Promise<AgentType | null> {
    const [result] = await db
      .select({ agentType: schema.agentsTable.agentType })
      .from(schema.agentsTable)
      .where(and(eq(schema.agentsTable.id, id), notDeleted(schema.agentsTable)))
      .limit(1);

    return result?.agentType ?? null;
  }

  /** Lock active participants in UUID order for shared-target and callable-name checks. */
  static async lockDelegationParticipants(params: {
    ids: string[];
    organizationId: string;
    tx: Transaction;
  }) {
    return params.tx
      .select({
        id: schema.agentsTable.id,
        agentType: schema.agentsTable.agentType,
      })
      .from(schema.agentsTable)
      .where(
        and(
          inArray(schema.agentsTable.id, params.ids),
          eq(schema.agentsTable.organizationId, params.organizationId),
          notDeleted(schema.agentsTable),
        ),
      )
      .orderBy(asc(schema.agentsTable.id))
      .for("update");
  }

  /**
   * Lock the agent row (SELECT ... FOR UPDATE) inside a transaction,
   * serializing writers that maintain the agent's child tables (e.g. the
   * tool-exclusions full replace) so concurrent replaces cannot interleave
   * their delete+insert phases into a merged state.
   */
  static async lockRowForUpdate(id: string, tx: Transaction): Promise<void> {
    await tx
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, id))
      .for("update");
  }

  /**
   * Every live agent that can serve as an MCP gateway in this organization, by
   * name. External clients register gateways under a server name derived from
   * these (see `resolveMcpClientServerName`), so the LLM proxy uses them to
   * recognize client-decorated gateway tool names. `isPersonalGateway` comes
   * along because a seeded personal gateway registers under the app name
   * rather than its own.
   */
  static async findGatewayNamesByOrganizationId(
    organizationId: string,
  ): Promise<{ name: string; isPersonalGateway: boolean }[]> {
    return db
      .select({
        name: schema.agentsTable.name,
        isPersonalGateway: schema.agentsTable.isPersonalGateway,
      })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.organizationId, organizationId),
          notDeleted(schema.agentsTable),
          inArray(schema.agentsTable.agentType, [
            ...GATEWAY_CAPABLE_AGENT_TYPES,
          ]),
        ),
      );
  }

  static async findIdsByOrganizationId(
    organizationId: string,
  ): Promise<string[]> {
    const agents = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.organizationId, organizationId),
          notDeleted(schema.agentsTable),
        ),
      );

    return agents.map((agent) => agent.id);
  }

  static async findAllIds(): Promise<string[]> {
    const agents = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(notDeleted(schema.agentsTable));

    return agents.map((agent) => agent.id);
  }

  /**
   * Ids of the org's non-deleted agents that go through the create-time
   * default tool hooks — i.e. excluding built-in system agents, which are
   * seeded via raw insert and deliberately bypass them.
   */
  static async findNonBuiltInIdsByOrganizationId(
    organizationId: string,
  ): Promise<string[]> {
    const agents = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.organizationId, organizationId),
          notDeleted(schema.agentsTable),
          isNull(schema.agentsTable.builtInAgentConfig),
        ),
      );

    return agents.map((agent) => agent.id);
  }

  /** Existing agents that still need at least one of the supplied tool assignments. */
  static async findNonBuiltInIdsMissingToolAssignments(params: {
    organizationId: string;
    toolIds: string[];
  }): Promise<string[]> {
    if (params.toolIds.length === 0) return [];
    const agents = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.organizationId, params.organizationId),
          notDeleted(schema.agentsTable),
          isNull(schema.agentsTable.builtInAgentConfig),
          exists(
            db
              .select({ id: schema.toolsTable.id })
              .from(schema.toolsTable)
              .where(
                and(
                  inArray(schema.toolsTable.id, params.toolIds),
                  notExists(
                    db
                      .select({ id: schema.agentToolsTable.id })
                      .from(schema.agentToolsTable)
                      .where(
                        and(
                          eq(
                            schema.agentToolsTable.agentId,
                            schema.agentsTable.id,
                          ),
                          eq(
                            schema.agentToolsTable.toolId,
                            schema.toolsTable.id,
                          ),
                        ),
                      ),
                  ),
                ),
              ),
          ),
        ),
      );
    return agents.map((agent) => agent.id);
  }

  /**
   * Whether `agentId` is its organization's LLM Proxy and `userId` a member of
   * that organization. See {@link organizationLlmProxyCondition}.
   */
  static async isOrganizationLlmProxyFor(params: {
    agentId: string;
    userId: string;
  }): Promise<boolean> {
    const [row] = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.id, params.agentId),
          notDeleted(schema.agentsTable),
          organizationLlmProxyCondition(params.userId),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  static async findAccessibleIdsForUser(
    userId: string,
    isAgentAdmin = false,
    principals?: GrantPrincipal[],
  ): Promise<string[]> {
    const readers =
      principals ??
      (await ResourcePermissionSubjectModel.resolvePrincipals({ userId }));
    const rows = await accessibleAgentIdsQuery({
      userId,
      isAgentAdmin,
      principals: readers,
    });

    return rows.map((row) => row.id);
  }

  /**
   * Internal agents eligible as Auto-mode delegation targets for a caller:
   * agentType "agent", not soft-deleted, that the caller holds a use grant on,
   * minus the caller agent itself. This is the delegation analog of
   * {@link ToolModel.getMcpToolsAccessibleToUser} — the dynamic surface for
   * `agents.access_all_subagents`. Admins see every internal agent.
   *
   * Built-in agents back platform machinery and are excluded.
   */
  static async findAccessibleDelegationTargets(params: {
    userId: string;
    isAdmin: boolean;
    organizationId: string;
    excludeAgentId: string;
    /**
     * The calling agent's environment: delegation never crosses environment
     * boundaries (null is the Default environment), mirroring tool isolation.
     */
    environmentId: string | null;
    lookups?: PrincipalSource;
  }): Promise<
    Pick<Agent, "id" | "name" | "description" | "builtInAgentConfig">[]
  > {
    const { userId, isAdmin, organizationId, excludeAgentId, environmentId } =
      params;

    const baseConditions = [
      eq(schema.agentsTable.organizationId, organizationId),
      eq(schema.agentsTable.agentType, "agent"),
      eq(schema.agentsTable.builtIn, false),
      ne(schema.agentsTable.id, excludeAgentId),
      environmentId === null
        ? isNull(schema.agentsTable.environmentId)
        : eq(schema.agentsTable.environmentId, environmentId),
      notDeleted(schema.agentsTable),
    ];

    if (isAdmin) {
      return db
        .selectDistinct({
          id: schema.agentsTable.id,
          name: schema.agentsTable.name,
          description: schema.agentsTable.description,
          builtInAgentConfig: schema.agentsTable.builtInAgentConfig,
        })
        .from(schema.agentsTable)
        .where(and(...baseConditions))
        .orderBy(asc(schema.agentsTable.name));
    }

    const principal = await ResourcePermissionSubjectModel.resolvePrincipalFrom(
      params.lookups,
      { organizationId, userId },
    );
    return db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        description: schema.agentsTable.description,
        builtInAgentConfig: schema.agentsTable.builtInAgentConfig,
      })
      .from(schema.agentsTable)
      .where(
        and(
          ...baseConditions,
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          ResourcePermissionPolicyModel.grantCondition({
            ...principal,
            resource: "agent",
            scopeColumn: schema.agentsTable.id,
            action: "use",
          }),
          // SPDX-SnippetEnd
        ),
      )
      .orderBy(asc(schema.agentsTable.name));
  }

  static async findDelegationTarget(
    id: string,
    tx?: Transaction,
  ): Promise<Pick<Agent, "id" | "name" | "agentType"> | null> {
    const [targetAgent] = await (tx ?? db)
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        agentType: schema.agentsTable.agentType,
      })
      .from(schema.agentsTable)
      .where(and(eq(schema.agentsTable.id, id), notDeleted(schema.agentsTable)))
      .limit(1);

    return targetAgent ?? null;
  }

  static async findAccessContextById(
    id: string,
  ): Promise<Pick<
    Agent,
    "id" | "organizationId" | "scope" | "authorId"
  > | null> {
    const [agent] = await db
      .select({
        id: schema.agentsTable.id,
        organizationId: schema.agentsTable.organizationId,
        scope: schema.agentsTable.scope,
        authorId: schema.agentsTable.authorId,
        createdByServiceAccountId: schema.agentsTable.createdByServiceAccountId,
      })
      .from(schema.agentsTable)
      .where(and(eq(schema.agentsTable.id, id), notDeleted(schema.agentsTable)))
      .limit(1);

    return agent ?? null;
  }

  /**
   * Batch fetch minimal agent data needed for permission checks.
   * Returns a Map of agentId -> { agentType, scope, authorId, teamIds }.
   * Much lighter than findById (no tool/label/knowledgeBase/connector joins).
   */
  /**
   * Includes `environmentId` so callers can apply the environment fence beside
   * the permission checks, without a second round-trip per target.
   *
   * `organizationId` is an OPTIONAL tenant fence. The scope checks downstream
   * cannot supply one: an admin check reads the caller's role in the caller's
   * OWN org, so nothing ever compares the target's tenant. Callers that accept agent ids
   * straight from a request body should pass it, which drops foreign-org agents
   * from the map and makes them indistinguishable from ids that do not exist.
   */
  static async findByIdsForPermissionCheck(
    ids: string[],
    organizationId?: string,
  ): Promise<
    Map<
      string,
      {
        agentType: AgentType;
        scope: AgentScope;
        authorId: string | null;
        teamIds: string[];
        environmentId: string | null;
      }
    >
  > {
    if (ids.length === 0) {
      return new Map();
    }

    // The audience and teams come from each agent's own grants, not the
    // retired scope and team rows, so assignability follows permission edits.
    const agents = await db
      .select({
        id: schema.agentsTable.id,
        agentType: schema.agentsTable.agentType,
        scope: sql<AgentScope>`CASE
          WHEN ${agentAudienceIs("org")} THEN 'org'
          WHEN ${agentAudienceIs("team")} THEN 'team'
          ELSE 'personal' END`,
        authorId: schema.agentsTable.authorId,
        teamIds: agentGrantedTeamIds(),
        createdByServiceAccountId: schema.agentsTable.createdByServiceAccountId,
        environmentId: schema.agentsTable.environmentId,
      })
      .from(schema.agentsTable)
      .where(
        and(
          inArray(schema.agentsTable.id, ids),
          notDeleted(schema.agentsTable),
          organizationId
            ? eq(schema.agentsTable.organizationId, organizationId)
            : undefined,
        ),
      );

    const result = new Map<
      string,
      {
        agentType: AgentType;
        scope: AgentScope;
        authorId: string | null;
        teamIds: string[];
        environmentId: string | null;
      }
    >();
    for (const agent of agents) {
      result.set(agent.id, {
        agentType: agent.agentType,
        scope: agent.scope,
        authorId: agent.authorId,
        teamIds: agent.teamIds,
        environmentId: agent.environmentId,
      });
    }

    return result;
  }

  /**
   * Batch check if multiple agents exist.
   * Returns a Set of agent IDs that exist.
   */
  static async existsBatch(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) {
      return new Set();
    }

    const results = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(
        and(
          inArray(schema.agentsTable.id, ids),
          notDeleted(schema.agentsTable),
        ),
      );

    return new Set(results.map((r) => r.id));
  }

  static async getRuntimePorts(params: {
    id: string;
    organizationId: string;
  }): Promise<number[]> {
    const [agent] = await db
      .select({ runtime: schema.agentsTable.runtime })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.id, params.id),
          eq(schema.agentsTable.organizationId, params.organizationId),
        ),
      )
      .limit(1);
    return agent?.runtime?.ports ?? [];
  }

  static async findById(
    id: string,
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<Agent | null> {
    // Check access control for non-agent admins
    if (userId && !isAgentAdmin) {
      const hasAccess = await AgentTeamModel.userHasAgentAccess({
        userId: userId,
        agentId: id,
        isAgentAdmin: false,
      });
      if (!hasAccess) {
        return null;
      }
    }

    const rows = await db
      .select()
      .from(schema.agentsTable)
      .leftJoin(
        schema.agentToolsTable,
        eq(schema.agentsTable.id, schema.agentToolsTable.agentId),
      )
      .leftJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .where(
        and(eq(schema.agentsTable.id, id), notDeleted(schema.agentsTable)),
      );

    if (rows.length === 0) {
      return null;
    }

    const agent = rows[0].agents;
    const tools = rows
      .map((row) => row.tools)
      .filter((tool): tool is NonNullable<typeof tool> => tool !== null);

    const [teams, labels, knowledgeBaseIds, connectorIds] = await Promise.all([
      AgentTeamModel.getTeamDetailsForAgent(id),
      AgentLabelModel.getLabelsForAgent(id),
      AgentKnowledgeBaseModel.getKnowledgeBaseIds(id),
      AgentConnectorAssignmentModel.getConnectorIds(id),
    ]);

    const result: Agent = {
      ...agent,
      tools,
      teams,
      users: await AgentUserModel.getUserDetailsForAgents([agent.id]).then(
        (map) => map.get(agent.id) ?? [],
      ),
      labels,
      knowledgeBaseIds,
      connectorIds,
      suggestedPrompts: [],
    };

    await Promise.all([
      AgentModel.populateGrantedScope([result]),
      AgentModel.populateAuthorNames([result]),
      AgentModel.populateSuggestedPrompts([result]),
      AgentModel.populateResolvedLlm([result]),
      AgentModel.populateSandboxAvailability([result], userId),
    ]);
    AgentModel.filterUnavailableKnowledgeTools([result]);

    return result;
  }

  /**
   * Hot-path agent lookup for the MCP gateway: the raw agents row plus labels,
   * skipping the tools join and the team/knowledge/connector/author/prompt/
   * resolved-LLM hydration {@link findById} performs. The gateway loads the
   * agent on every JSON-RPC request only for scalar config (agent type, tool
   * exposure, passthrough headers, identity provider) and trace-span labels,
   * so this must stay at two index lookups.
   */
  static async findGatewayAgentById(id: string): Promise<GatewayAgent | null> {
    const [agent] = await db
      .select()
      .from(schema.agentsTable)
      .where(and(eq(schema.agentsTable.id, id), notDeleted(schema.agentsTable)))
      .limit(1);

    if (!agent) {
      return null;
    }

    const labels = await AgentLabelModel.getLabelsForAgent(id);
    return { ...agent, labels };
  }

  /**
   * The organization's LLM Proxy — the single `llm_proxy` row every proxy
   * request in the organization resolves to. Lean shape for the proxy hot
   * path (raw row plus labels, like {@link findGatewayAgentById}). Creates
   * the row on first use; creation is race-safe via the partial unique index
   * `agents_org_default_llm_proxy_idx`.
   */
  static async getOrgLlmProxy(organizationId: string): Promise<GatewayAgent> {
    const existing = await AgentModel.findOrgLlmProxyRow(organizationId);
    if (existing) {
      const labels = await AgentLabelModel.getLabelsForAgent(existing.id);
      return { ...existing, labels };
    }

    await db
      .insert(schema.agentsTable)
      .values(
        await CreatedByModel.forInsert({
          data: {
            organizationId,
            name: DEFAULT_LLM_PROXY_NAME,
            agentType: "llm_proxy",
            isDefault: true,
            scope: "org",
          },
          userIdField: "authorId",
        }),
      )
      .onConflictDoNothing({
        target: [schema.agentsTable.organizationId],
        where: sql`${schema.agentsTable.agentType} = 'llm_proxy' AND ${schema.agentsTable.isDefault} = true AND ${schema.agentsTable.deletedAt} IS NULL`,
      });

    const row = await AgentModel.findOrgLlmProxyRow(organizationId);
    if (!row) {
      throw new Error(
        `Failed to ensure the LLM Proxy for organization ${organizationId}`,
      );
    }
    const labels = await AgentLabelModel.getLabelsForAgent(row.id);
    return { ...row, labels };
  }

  /**
   * Each organization's elected LLM Proxy, keyed by organization id.
   *
   * Read-only, unlike {@link getOrgLlmProxy}: reporting paths look at history
   * for organizations they do not otherwise touch, and must not mint a proxy
   * row as a side effect of being read. Organizations without one are simply
   * absent from the map.
   */
  static async findOrgLlmProxies(
    organizationIds: string[],
  ): Promise<Map<string, { id: string; name: string }>> {
    if (organizationIds.length === 0) {
      return new Map();
    }

    const rows = await db
      .select({
        organizationId: schema.agentsTable.organizationId,
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
      })
      .from(schema.agentsTable)
      .where(
        and(
          inArray(schema.agentsTable.organizationId, organizationIds),
          eq(schema.agentsTable.agentType, "llm_proxy"),
          eq(schema.agentsTable.isDefault, true),
          notDeleted(schema.agentsTable),
        ),
      );

    return new Map(
      rows.map((row) => [row.organizationId, { id: row.id, name: row.name }]),
    );
  }

  private static async findOrgLlmProxyRow(organizationId: string) {
    const [row] = await db
      .select()
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.organizationId, organizationId),
          eq(schema.agentsTable.agentType, "llm_proxy"),
          eq(schema.agentsTable.isDefault, true),
          notDeleted(schema.agentsTable),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * The deployment's LLM Proxy for proxy requests that carry no organization
   * context (an id-less proxy URL): the first organization's proxy. Null only
   * when no organization exists yet.
   */
  static async getDeploymentLlmProxy(): Promise<GatewayAgent | null> {
    const [firstOrg] = await db
      .select({ id: schema.organizationsTable.id })
      .from(schema.organizationsTable)
      // Deterministic "first organization": the oldest one. Without an order
      // the planner may return different rows across calls.
      .orderBy(asc(schema.organizationsTable.createdAt))
      .limit(1);
    if (!firstOrg) {
      return null;
    }
    return AgentModel.getOrgLlmProxy(firstOrg.id);
  }

  /** Ensures every organization has its LLM Proxy row. Runs at startup. */
  static async ensureLlmProxiesForAllOrganizations(): Promise<void> {
    const orgs = await db
      .select({ id: schema.organizationsTable.id })
      .from(schema.organizationsTable);
    for (const org of orgs) {
      await AgentModel.getOrgLlmProxy(org.id);
    }
  }

  /**
   * Updates the LLM Proxy's identity provider (JWT/JWKS authentication for
   * proxy requests). Returns the updated proxy.
   */
  static async setOrgLlmProxyIdentityProvider(params: {
    organizationId: string;
    identityProviderId: string | null;
  }): Promise<GatewayAgent> {
    const proxy = await AgentModel.getOrgLlmProxy(params.organizationId);
    await db
      .update(schema.agentsTable)
      .set({ identityProviderId: params.identityProviderId })
      .where(eq(schema.agentsTable.id, proxy.id));
    return { ...proxy, identityProviderId: params.identityProviderId };
  }

  /**
   * Audit snapshot of the LLM Proxy. Keyed by organization: the audit
   * registry resolves the `/api/llm-proxy` route through organization
   * context, not a route param.
   */
  static async findOrgLlmProxyForAudit(
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await AgentModel.findOrgLlmProxyRow(organizationId);
    if (!row) return null;
    return { id: row.id, identityProviderId: row.identityProviderId };
  }

  /**
   * Minimal agent lookup for opening a conversation: the SAME access gate as
   * {@link findById}, but selecting only the LLM-selection fields that path uses
   * (`llmApiKeyId`, `modelId`). Skips the tool join and the
   * team/label/knowledge/connector/author/prompt/resolved-LLM hydration that
   * dominate `findById`'s cost and are unused when creating a conversation.
   */
  static async findLlmSelectionFieldsById(
    id: string,
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<{ llmApiKeyId: string | null; modelId: string | null } | null> {
    if (userId && !isAgentAdmin) {
      const hasAccess = await AgentTeamModel.userHasAgentAccess({
        userId: userId,
        agentId: id,
        isAgentAdmin: false,
      });
      if (!hasAccess) {
        return null;
      }
    }

    const rows = await db
      .select({
        llmApiKeyId: schema.agentsTable.llmApiKeyId,
        modelId: schema.agentsTable.modelId,
      })
      .from(schema.agentsTable)
      .where(and(eq(schema.agentsTable.id, id), notDeleted(schema.agentsTable)))
      .limit(1);

    return rows[0] ?? null;
  }

  static async findDeletedByIdForOrganization(
    id: string,
    organizationId: string,
  ): Promise<Agent | null> {
    const rows = await db
      .select()
      .from(schema.agentsTable)
      .leftJoin(
        schema.agentToolsTable,
        eq(schema.agentsTable.id, schema.agentToolsTable.agentId),
      )
      .leftJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .where(
        and(
          eq(schema.agentsTable.id, id),
          eq(schema.agentsTable.organizationId, organizationId),
          isNotNull(schema.agentsTable.deletedAt),
        ),
      );

    if (rows.length === 0) {
      return null;
    }

    const agent = rows[0].agents;
    const tools = rows
      .map((row) => row.tools)
      .filter((tool): tool is NonNullable<typeof tool> => tool !== null);

    const [teams, labels, knowledgeBaseIds, connectorIds] = await Promise.all([
      AgentTeamModel.getTeamDetailsForAgent(id),
      AgentLabelModel.getLabelsForAgent(id),
      AgentKnowledgeBaseModel.getKnowledgeBaseIds(id),
      AgentConnectorAssignmentModel.getConnectorIds(id),
    ]);

    const result: Agent = {
      ...agent,
      tools,
      teams,
      users: await AgentUserModel.getUserDetailsForAgents([agent.id]).then(
        (map) => map.get(agent.id) ?? [],
      ),
      labels,
      knowledgeBaseIds,
      connectorIds,
      suggestedPrompts: [],
    };

    await Promise.all([
      AgentModel.populateGrantedScope([result]),
      AgentModel.populateAuthorNames([result]),
      AgentModel.populateSuggestedPrompts([result]),
      AgentModel.populateResolvedLlm([result]),
    ]);

    return result;
  }

  /**
   * The org's default agent of a given type (`isDefault = true`), if one exists.
   * Used as the implicit fallback when a caller cannot pick an agent — e.g. a
   * user without `agent:read` creating a scheduled task. Returns id-level
   * metadata only; null when the org has no default of that type.
   */
  static async findDefaultByType(params: {
    organizationId: string;
    agentType: AgentType;
  }): Promise<{ id: string; agentType: AgentType } | null> {
    const [row] = await db
      .select({
        id: schema.agentsTable.id,
        agentType: schema.agentsTable.agentType,
      })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.organizationId, params.organizationId),
          eq(schema.agentsTable.agentType, params.agentType),
          eq(schema.agentsTable.isDefault, true),
          notDeleted(schema.agentsTable),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * A project's `default_agent_id` as a candidate: a live, non-built-in chat
   * agent in the given organization, with the `scope` its caller needs to judge
   * whether the project's audience can reach it (`projectService`).
   *
   * Callers run this on read as well as write — agents soft-delete, so the FK's
   * SET NULL never fires and a pin outlives its target.
   */
  static async findPinnableProjectDefault(params: {
    id: string;
    organizationId: string;
  }): Promise<{ id: string; name: string; scope: AgentScope } | null> {
    const [row] = await db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        scope: schema.agentsTable.scope,
      })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.id, params.id),
          eq(schema.agentsTable.organizationId, params.organizationId),
          eq(schema.agentsTable.agentType, "agent"),
          eq(schema.agentsTable.builtIn, false),
          notDeleted(schema.agentsTable),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Update the server-managed secret bag behind Agent Runtime.
   * Credential values never travel through the generic Agent update body.
   */
  static async setAgentRuntimeSecretId(params: {
    id: string;
    secretId: string | null;
  }): Promise<boolean> {
    const updated = await db
      .update(schema.agentsTable)
      .set({
        runtimeSecretId: params.secretId,
        updatedAt: new Date(),
      })
      .where(eq(schema.agentsTable.id, params.id))
      .returning({ id: schema.agentsTable.id });
    return updated.length > 0;
  }

  /** Change only ownership, and refuse a stale authorization snapshot. */
  static async transferOwnership(params: {
    id: string;
    organizationId: string;
    previousOwnerId: string | null;
    updatedAt: Date;
    ownerId: string;
  }): Promise<boolean> {
    const rows = await db
      .update(schema.agentsTable)
      .set({
        authorId: params.ownerId,
        createdByServiceAccountId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.agentsTable.id, params.id),
          eq(schema.agentsTable.organizationId, params.organizationId),
          params.previousOwnerId === null
            ? isNull(schema.agentsTable.authorId)
            : eq(schema.agentsTable.authorId, params.previousOwnerId),
          // PostgreSQL defaults can carry sub-millisecond precision; JS Date cannot.
          sql`date_trunc('milliseconds', ${schema.agentsTable.updatedAt}) = ${params.updatedAt.toISOString()}::timestamp`,
          notDeleted(schema.agentsTable),
        ),
      )
      .returning({ id: schema.agentsTable.id });
    return rows.length === 1;
  }

  static async update(
    id: string,
    {
      teams,
      users,
      labels,
      knowledgeBaseIds,
      connectorIds,
      suggestedPrompts,
      ...agent
    }: Partial<UpdateAgent> & {
      /**
       * Retired sharing columns. No longer reachable from a request body —
       * access lives in the resource permission policy — but still written by
       * the bulk visibility route and by seeding/migration callers.
       */
      scope?: AgentScope;
      teams?: string[];
      users?: string[];
    },
    options?: {
      /**
       * Skip the off→on All-tools exclusion pre-fill. Used by clone, which
       * copies the source's exclusion rows verbatim and must not have the
       * additive pre-fill re-add built-ins the source had un-excluded.
       */
      skipExclusionPrefill?: boolean;
      /**
       * Skip this update's config version fork. Set by callers that replay
       * several writes as one user action and fork once at the end (see
       * `restoreAgentVersion`) — one action should produce one version.
       *
       * The returned agent's `latestVersion` is then whatever the head was
       * BEFORE the caller's own closing fork, so a caller that surfaces it
       * must re-read the agent afterwards.
       */
      deferVersionFork?: boolean;
    },
  ): Promise<Agent | null> {
    let updatedAgent:
      | Omit<
          Agent,
          | "tools"
          | "teams"
          | "labels"
          | "knowledgeBaseIds"
          | "connectorIds"
          | "suggestedPrompts"
        >
      | undefined;

    // Fetch existing agent to check for name changes (needed for delegation tool sync)
    const [existingAgent] = await db
      .select()
      .from(schema.agentsTable)
      .where(
        and(eq(schema.agentsTable.id, id), notDeleted(schema.agentsTable)),
      );

    if (!existingAgent) {
      return null;
    }

    // Keep the all-tools ⇒ progressive-loading invariant on every update path:
    // if the agent's effective accessAllTools is on, force search_and_run_only.
    // Only mutate when there is an actual inconsistency to fix, so unrelated
    // updates don't spuriously rewrite the exposure mode.
    const effectiveAccessAllTools =
      agent.accessAllTools ?? existingAgent.accessAllTools;
    const effectiveToolExposureMode =
      agent.toolExposureMode ?? existingAgent.toolExposureMode;
    if (
      effectiveAccessAllTools &&
      effectiveToolExposureMode !== "search_and_run_only"
    ) {
      agent.toolExposureMode = "search_and_run_only";
    }

    // If setting isDefault to true, unset isDefault for other agents of the same type
    if (agent.isDefault === true) {
      await db
        .update(schema.agentsTable)
        .set({ isDefault: false })
        .where(
          and(
            eq(schema.agentsTable.isDefault, true),
            eq(schema.agentsTable.agentType, existingAgent.agentType),
            notDeleted(schema.agentsTable),
          ),
        );
    }

    // Switching accessAllTools off→on pre-fills the agent's exclusion list
    // with every unassigned built-in tool outside the exempt set. Flip and
    // pre-fill commit in ONE transaction (serialized by the same row lock the
    // exclusions full-replace takes) so the agent can never sit in Auto mode
    // without its pre-fill; every off→on switch re-runs it (additively).
    // on→on or →off updates never touch the exclusion rows.
    const prefillsExclusions =
      agent.accessAllTools === true &&
      !existingAgent.accessAllTools &&
      !options?.skipExclusionPrefill;

    // Only update agent table if there are fields to update
    if (Object.keys(agent).length > 0) {
      const updateWhere = and(
        eq(schema.agentsTable.id, id),
        notDeleted(schema.agentsTable),
      );
      const [row] = prefillsExclusions
        ? await withDbTransaction(async (tx) => {
            await AgentModel.lockRowForUpdate(id, tx);
            const rows = await tx
              .update(schema.agentsTable)
              .set(agent)
              .where(updateWhere)
              .returning();
            if (rows.length > 0) {
              await AgentExcludedToolModel.prefillForAllToolsMode(id, tx);
            }
            return rows;
          })
        : await db
            .update(schema.agentsTable)
            .set(agent)
            .where(updateWhere)
            .returning();

      if (!row) {
        return null;
      }
      updatedAgent = row;

      // If name changed, sync delegation tool names and invalidate parent caches
      if (agent.name && agent.name !== existingAgent.name) {
        await ToolModel.syncDelegationToolNames(id, agent.name);

        // Invalidate tool cache for all parent agents so they pick up the new tool name
        const parentAgentIds = await ToolModel.getParentAgentIds(id);
        // Lazy (here and below): the chat MCP client imports the service
        // layer, which would otherwise load with every model.
        const { clearChatMcpClient } = await import(
          "@/clients/chat-mcp-client"
        );
        for (const parentAgentId of parentAgentIds) {
          clearChatMcpClient(parentAgentId);
        }
      }

      // The advertised tool surface depends on toolExposureMode (full vs the
      // search_tools/run_tool dispatch surface) and accessAllTools. A cached
      // chat MCP client freezes that surface at connection-build time, so a
      // change here must evict the client — otherwise switching an agent to
      // "all tools" / search_and_run_only doesn't expose run_tool/search_tools
      // until the connection is rebuilt for some unrelated reason.
      if (
        updatedAgent.toolExposureMode !== existingAgent.toolExposureMode ||
        updatedAgent.accessAllTools !== existingAgent.accessAllTools
      ) {
        const { clearChatMcpClient } = await import(
          "@/clients/chat-mcp-client"
        );
        clearChatMcpClient(id);
      }
    } else {
      updatedAgent = existingAgent;
    }

    // Sync team assignments if teams is provided
    if (teams !== undefined) {
      await AgentTeamModel.syncAgentTeams(id, teams);
    }

    // Sync individual grants; `[]` revokes them all, omitted leaves them alone.
    if (users !== undefined) {
      await AgentUserModel.syncAgentUsers(id, users);
    }

    // Sync label assignments if labels is provided
    if (labels !== undefined) {
      await AgentLabelModel.syncAgentLabels(id, labels);
    }

    // Sync knowledge base assignments if knowledgeBaseIds is provided
    if (knowledgeBaseIds !== undefined) {
      await AgentKnowledgeBaseModel.syncForAgent(id, knowledgeBaseIds);
    }

    // Sync connector assignments if connectorIds is provided
    if (connectorIds !== undefined) {
      await AgentConnectorAssignmentModel.syncForAgent(id, connectorIds);
    }

    // Sync suggested prompts if provided
    if (suggestedPrompts !== undefined) {
      await AgentSuggestedPromptModel.syncForAgent({
        agentId: id,
        prompts: suggestedPrompts,
      });
    }

    // Any write above may have changed the canonical config — fork a version
    // if so. Deliberately after the junction syncs (the snapshot must capture
    // this mutation's final state), and unconditionally: a relational-only
    // update skips the agents-row write yet still changes config. Best-effort:
    // a versioning failure must never fail the update itself.
    if (!options?.deferVersionFork) {
      const fork = await AgentVersionModel.forkIfChangedBestEffort(id);
      if (fork && updatedAgent) {
        updatedAgent.latestVersion = fork.version;
      }
    }

    const [
      toolRows,
      currentTeams,
      currentLabels,
      currentKbIds,
      currentConnectorIds,
      currentSuggestedPrompts,
    ] = await Promise.all([
      AgentToolModel.getToolsForAgent(id),
      AgentTeamModel.getTeamDetailsForAgent(id),
      AgentLabelModel.getLabelsForAgent(id),
      AgentKnowledgeBaseModel.getKnowledgeBaseIds(id),
      AgentConnectorAssignmentModel.getConnectorIds(id),
      AgentSuggestedPromptModel.getForAgents([id]),
    ]);

    if (!updatedAgent) return null;

    const result = {
      ...updatedAgent,
      tools: toolRows,
      teams: currentTeams,
      labels: currentLabels,
      knowledgeBaseIds: currentKbIds,
      connectorIds: currentConnectorIds,
      suggestedPrompts: currentSuggestedPrompts.get(id) ?? [],
    };
    await AgentModel.populateGrantedScope([result]);
    return result;
  }

  /**
   * Find a built-in agent by its config name discriminator.
   * When organizationId is provided, scopes the query to that org
   * (important for multi-org deployments where each org has its own built-in agent row).
   */
  static async getBuiltInAgent(
    builtInName: string,
    organizationId?: string,
  ): Promise<Agent | null> {
    const conditions: SQL[] = [
      sql`${schema.agentsTable.builtInAgentConfig}->>'name' = ${builtInName}`,
      notDeleted(schema.agentsTable),
    ];
    if (organizationId) {
      conditions.push(eq(schema.agentsTable.organizationId, organizationId));
    }

    const [row] = await db
      .select()
      .from(schema.agentsTable)
      .where(and(...conditions))
      .limit(1);

    if (!row) return null;

    const [teams, labels] = await Promise.all([
      AgentTeamModel.getTeamDetailsForAgent(row.id),
      AgentLabelModel.getLabelsForAgent(row.id),
    ]);

    const toolRows = await db
      .select({ tool: agentToolRefColumns })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .where(eq(schema.agentToolsTable.agentId, row.id));

    return {
      ...row,
      tools: toolRows.map((r) => r.tool),
      teams,
      labels,
      knowledgeBaseIds: await AgentKnowledgeBaseModel.getKnowledgeBaseIds(
        row.id,
      ),
      connectorIds: await AgentConnectorAssignmentModel.getConnectorIds(row.id),
      suggestedPrompts: [],
    };
  }

  static async delete(id: string, tx?: Transaction): Promise<boolean> {
    const count = await softDelete(
      tx ?? db,
      schema.agentsTable,
      eq(schema.agentsTable.id, id),
    );
    return count > 0;
  }

  static async restore(id: string, tx?: Transaction): Promise<boolean> {
    const count = await restore(
      tx ?? db,
      schema.agentsTable,
      eq(schema.agentsTable.id, id),
    );
    return count > 0;
  }

  static async getRestoreConflictMessage(agent: Agent): Promise<string | null> {
    if (agent.slug) {
      const [slugConflict] = await db
        .select({ id: schema.agentsTable.id })
        .from(schema.agentsTable)
        .where(
          and(
            eq(schema.agentsTable.slug, agent.slug),
            ne(schema.agentsTable.id, agent.id),
            notDeleted(schema.agentsTable),
          ),
        )
        .limit(1);

      if (slugConflict) {
        return `Cannot restore because another active ${getAgentTypeLabel(agent.agentType)} is already using this name.`;
      }
    }

    if (
      agent.agentType === "mcp_gateway" &&
      agent.isPersonalGateway &&
      agent.authorId
    ) {
      const [personalGatewayConflict] = await db
        .select({ id: schema.agentsTable.id })
        .from(schema.agentsTable)
        .where(
          and(
            eq(schema.agentsTable.organizationId, agent.organizationId),
            eq(schema.agentsTable.authorId, agent.authorId),
            eq(schema.agentsTable.agentType, "mcp_gateway"),
            eq(schema.agentsTable.isPersonalGateway, true),
            ne(schema.agentsTable.id, agent.id),
            notDeleted(schema.agentsTable),
          ),
        )
        .limit(1);

      if (personalGatewayConflict) {
        return "Cannot restore because this user already has an active personal MCP gateway.";
      }
    }

    if (agent.isDefault) {
      const [defaultConflict] = await db
        .select({ id: schema.agentsTable.id })
        .from(schema.agentsTable)
        .where(
          and(
            eq(schema.agentsTable.organizationId, agent.organizationId),
            eq(schema.agentsTable.agentType, agent.agentType),
            eq(schema.agentsTable.isDefault, true),
            ne(schema.agentsTable.id, agent.id),
            notDeleted(schema.agentsTable),
          ),
        )
        .limit(1);

      if (defaultConflict) {
        return `Cannot restore because another active default ${getAgentTypeLabel(agent.agentType)} already exists.`;
      }
    }

    return null;
  }

  static async hardDelete(id: string, tx?: Transaction): Promise<boolean> {
    const run = async (transaction: Transaction) => {
      const count = await hardDelete(
        transaction,
        schema.agentsTable,
        eq(schema.agentsTable.id, id),
      );
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      if (count > 0)
        await ResourcePermissionPolicyModel.deleteForTarget({
          tx: transaction,
          resources: ["agent", "mcpGateway"],
          scope: id,
        });
      // SPDX-SnippetEnd
      return count > 0;
    };
    return tx ? run(tx) : withDbTransaction(run);
  }

  /**
   * Permanently destroy a soft-deleted agent. Irreversible.
   *
   * Everything the agent owns goes by cascade: versions, tool assignments and
   * exclusions, team/user grants, labels, knowledge bases, connector
   * assignments, suggested prompts, hook files, scheduled triggers and their
   * runs, chatops bindings, connection setups, and gateway tasks. Its history
   * SURVIVES, detached: conversations, interactions, MCP tool calls, and A2A
   * tasks all have `ON DELETE SET NULL` on their agent column. The org, member,
   * and /connection defaults clear themselves the same way — those foreign keys
   * exist in the database even though Drizzle cannot declare them (they would
   * make organization → agent → organization circular).
   *
   * ## Why the statement timeout is raised, and why only to five minutes
   *
   * `interactions.profile_id` is one of those `SET NULL` columns, and a busy
   * LLM proxy owns millions of rows there. Postgres performs that rewrite
   * INSIDE the DELETE statement, so the pool-wide 30s `statement_timeout`
   * applies to the whole cascade and would abort — identically on every retry,
   * making a large proxy permanently un-purgeable. `SET LOCAL` scopes the
   * change to this transaction and reverts on commit, so no other query loses
   * its safety net.
   *
   * There is also a floor cost independent of the agent's size:
   * `conversations.agent_id` and `tools.agent_id` carry no index, so each
   * constraint is enforced with a sequential scan of its table. Indexing them
   * to speed up a rare admin action would tax every insert into those tables
   * forever, which is not a trade worth making.
   *
   * Five minutes rather than no limit at all. The transaction is long by
   * design: it blocks no proxy traffic — interactions are insert-only, and this
   * touches existing rows — but it holds back vacuum cleanup database-wide
   * while it runs and pins a pool connection, so it needs an end. Postgres
   * counts lock waits toward `statement_timeout`, so this bounds a purge stuck
   * behind someone else's lock too, and no separate `lock_timeout` is needed. A
   * purge that genuinely needs longer fails with SQLSTATE 57014 and leaves the
   * agent in the trash, unharmed — the whole thing is one transaction, so an
   * interruption discards all of its progress rather than half-purging. That
   * revives the un-purgeable-proxy problem above for the very largest agents;
   * raise this deliberately if one ever shows up, rather than removing it.
   *
   * Returns false when there was no soft-deleted row to take, which is how a
   * restore that won the race reports itself.
   */
  static async purge(id: string, organizationId: string): Promise<boolean> {
    return withDbTransaction(async (tx) => {
      // `sql.raw`, not an interpolated value: SET is a utility command and
      // takes no bind parameters, so `= $1` is a syntax error. The value is a
      // module constant, never caller input.
      await tx.execute(
        sql.raw(`SET LOCAL statement_timeout = ${PURGE_STATEMENT_TIMEOUT_MS}`),
      );

      // The row lock is the race guard: a concurrent restore either commits
      // first (leaving no soft-deleted row here) or blocks until this
      // transaction commits and then finds no row at all. Restore wins, and
      // never against a half-purged agent.
      const [locked] = await tx
        .select({ id: schema.agentsTable.id })
        .from(schema.agentsTable)
        .where(
          and(
            eq(schema.agentsTable.id, id),
            eq(schema.agentsTable.organizationId, organizationId),
            isNotNull(schema.agentsTable.deletedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!locked) return false;

      return AgentModel.hardDelete(id, tx);
    });
  }

  /** Check if an agent has any Playwright tools assigned via agent_tools. */
  static async hasPlaywrightToolsAssigned(agentId: string): Promise<boolean> {
    const rows = await db
      .select({ id: schema.toolsTable.id })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          eq(schema.toolsTable.catalogId, PLAYWRIGHT_MCP_CATALOG_ID),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Startup candidates only: existing live personal agents need no repair. */
  static async findMembersMissingPersonalChatAgents() {
    return db
      .select({
        userId: schema.membersTable.userId,
        organizationId: schema.membersTable.organizationId,
      })
      .from(schema.membersTable)
      .where(
        and(
          isNull(schema.membersTable.defaultAgentId),
          not(
            exists(
              db
                .select({ id: schema.agentsTable.id })
                .from(schema.agentsTable)
                .where(
                  and(
                    ...personalChatAgentConditions({
                      userId: schema.membersTable.userId,
                      organizationId: schema.membersTable.organizationId,
                    }),
                    notDeleted(schema.agentsTable),
                  ),
                ),
            ),
          ),
        ),
      );
  }

  /**
   * Ensure a personal chat agent exists for a member, and return the one they
   * should chat with — their oldest live personal chat agent.
   *
   * Idempotent, and deliberately keyed on authorship alone: having *ever*
   * authored a personal chat agent in this organization is the durable marker
   * (soft-deleted rows count), so deleting the seeded assistant does not bring
   * it straight back on the next login, app chat, or backend start. It must not
   * key on `members.default_agent_id`, which now records only a deliberate
   * choice and is null for almost everyone — reading it here would re-seed an
   * assistant per login for every member who never picked one.
   *
   * Returns null only for a member who authored personal chat agents and then
   * deleted them all: seeding is skipped by design, and they have none live.
   */
  static async ensurePersonalChatAgent(params: {
    userId: string;
    organizationId: string;
  }): Promise<string | null> {
    const { userId, organizationId } = params;

    // Live agents first: this is the common path (every login and app chat),
    // and it answers in one indexed query.
    const [existing] = await AgentModel.findOwnPersonalChatAgentIds(params);
    if (existing) return existing;
    // None live. Seed only for a member who never had one — soft-deleted rows
    // are the durable marker that they did and chose to delete it.
    if (await AgentModel.hasEverAuthoredPersonalChatAgent(params)) return null;

    const agent = await AgentModel.create(
      {
        organizationId,
        name: "My Assistant",
        agentType: "agent",
        scope: "personal",
        description: "Your personal chat assistant",
        // The personal assistant should be able to reach every tool the user
        // can access (e.g. MCP servers they install) without per-tool
        // assignment. `accessAllTools` grants that dynamic access and, via the
        // invariant in AgentModel.create, coerces toolExposureMode to
        // "search_and_run_only" so the search_tools/run_tool dispatch surface
        // is exposed.
        accessAllTools: true,
      },
      userId,
    );

    // The default built-in tools (artifact_write, todo_write,
    // query_knowledge_sources) are assigned inside AgentModel.create along
    // with the rest of the creation-default set.

    logger.debug(
      { userId, organizationId, agentId: agent.id },
      "Created personal chat agent",
    );

    return agent.id;
  }

  /**
   * The member's personal chat agent (their oldest live one), without seeding
   * one. Null when they have none.
   */
  static async findPersonalChatAgentId(params: {
    userId: string;
    organizationId: string;
  }): Promise<string | null> {
    const [id] = await AgentModel.findOwnPersonalChatAgentIds(params);
    return id ?? null;
  }

  /**
   * Live personal chat agents this member authored in the organization,
   * oldest first, excluding `excludeId`.
   */
  private static async findOwnPersonalChatAgentIds(params: {
    userId: string;
    organizationId: string;
    excludeId?: string;
  }): Promise<string[]> {
    const rows = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(
        and(
          ...personalChatAgentConditions(params),
          notDeleted(schema.agentsTable),
        ),
      )
      // `id` breaks a createdAt tie so "the member's own personal chat agent"
      // is one stable answer — the same order migration 0426 used to recognise
      // the implicitly adopted defaults it cleared.
      .orderBy(asc(schema.agentsTable.createdAt), asc(schema.agentsTable.id));
    return rows.map((row) => row.id);
  }

  private static async hasEverAuthoredPersonalChatAgent(params: {
    userId: string;
    organizationId: string;
  }): Promise<boolean> {
    const [row] = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(and(...personalChatAgentConditions(params)))
      .limit(1);
    return row !== undefined;
  }

  /**
   * Returns the user's personal MCP gateway for the given organization, or null
   * if none exists.
   */
  static async getPersonalMcpGateway(
    userId: string,
    organizationId: string,
  ): Promise<Agent | null> {
    const [row] = await db
      .select()
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.organizationId, organizationId),
          eq(schema.agentsTable.authorId, userId),
          eq(schema.agentsTable.agentType, "mcp_gateway"),
          eq(schema.agentsTable.isPersonalGateway, true),
          notDeleted(schema.agentsTable),
        ),
      )
      .limit(1);

    if (!row) return null;
    return (await AgentModel.findById(row.id, userId, true)) ?? null;
  }

  /** The author of a personal MCP gateway, or undefined if `id` is not one. */
  static async findPersonalMcpGatewayAuthor(params: {
    id: string;
    organizationId: string;
  }): Promise<{ authorId: string | null } | undefined> {
    const [row] = await db
      .select({ authorId: schema.agentsTable.authorId })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.id, params.id),
          eq(schema.agentsTable.organizationId, params.organizationId),
          eq(schema.agentsTable.isPersonalGateway, true),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * Ensures the user has a personal MCP gateway for the given organization.
   * Idempotent: returns the existing one if present, otherwise creates one.
   * The personal gateway auto-collects tools from MCP servers the user installs
   * and cannot be deleted.
   */
  static async ensurePersonalMcpGateway(params: {
    userId: string;
    organizationId: string;
  }): Promise<Agent> {
    const { userId, organizationId } = params;

    const existing = await AgentModel.getPersonalMcpGateway(
      userId,
      organizationId,
    );
    if (existing) return existing;

    const [userRow] = await db
      .select({ name: schema.usersTable.name })
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, userId))
      .limit(1);
    const userPart = (userRow && urlSlugify(userRow.name)) || userId;
    const slug = `my-gateway-${userPart}-${crypto.randomUUID().slice(0, 6)}`;

    try {
      const gateway = await AgentModel.create(
        {
          organizationId,
          name: PERSONAL_MCP_GATEWAY_NAME,
          slug,
          agentType: "mcp_gateway",
          scope: "personal",
          description: PERSONAL_MCP_GATEWAY_DESCRIPTION,
          isPersonalGateway: true,
          // The personal gateway defaults to "All" mode so it can reach every
          // tool the user can access without per-tool assignment. Via the
          // invariant in AgentModel.create, accessAllTools coerces
          // toolExposureMode to "search_and_run_only" (the search_tools/run_tool
          // dispatch surface).
          accessAllTools: true,
        },
        userId,
      );

      logger.debug(
        { userId, organizationId, agentId: gateway.id },
        "Created personal MCP gateway",
      );

      return gateway;
    } catch (error) {
      // Lost a race against a concurrent caller — re-fetch the row that won.
      // Drizzle wraps the pg error, so use the cause-walking helper rather than
      // checking error.message directly (the index name lives on error.cause).
      if (
        !isUniqueConstraintError(error) ||
        !errorMentions(error, "agents_personal_gateway_per_member_idx")
      ) {
        throw error;
      }

      const winner = await AgentModel.getPersonalMcpGateway(
        userId,
        organizationId,
      );
      if (!winner) throw error;
      return winner;
    }
  }

  /**
   * Bulk-creates personal MCP gateways for every member that lacks one. Uses
   * a single LEFT JOIN to find the missing (userId, organizationId) pairs and
   * a single bulk INSERT. Intended for the startup backfill — for new members
   * created at runtime, use {@link AgentModel.ensurePersonalMcpGateway}.
   * Returns the number of rows actually inserted.
   */
  static async bulkBackfillPersonalMcpGateways(): Promise<number> {
    const missing = await db
      .select({
        userId: schema.membersTable.userId,
        organizationId: schema.membersTable.organizationId,
        userName: schema.usersTable.name,
      })
      .from(schema.membersTable)
      .innerJoin(
        schema.usersTable,
        eq(schema.usersTable.id, schema.membersTable.userId),
      )
      .leftJoin(
        schema.agentsTable,
        and(
          eq(schema.agentsTable.authorId, schema.membersTable.userId),
          eq(
            schema.agentsTable.organizationId,
            schema.membersTable.organizationId,
          ),
          eq(schema.agentsTable.agentType, "mcp_gateway"),
          eq(schema.agentsTable.isPersonalGateway, true),
        ),
      )
      .where(isNull(schema.agentsTable.id));

    if (missing.length === 0) return 0;

    const rows = missing.map((m) => {
      const userPart = urlSlugify(m.userName) || m.userId;
      return {
        organizationId: m.organizationId,
        authorId: m.userId,
        name: PERSONAL_MCP_GATEWAY_NAME,
        description: PERSONAL_MCP_GATEWAY_DESCRIPTION,
        agentType: "mcp_gateway" as const,
        scope: "personal" as const,
        isPersonalGateway: true,
        // Personal gateways default to "All" mode (see ensurePersonalMcpGateway).
        // This raw INSERT bypasses AgentModel.create, so set both fields here to
        // preserve the accessAllTools => search_and_run_only invariant.
        accessAllTools: true,
        toolExposureMode: "search_and_run_only" as const,
        slug: `my-gateway-${userPart}-${crypto.randomUUID().slice(0, 6)}`,
      };
    });

    const inserted = await withDbTransaction(async (tx) => {
      const insertedRows = await tx
        .insert(schema.agentsTable)
        .values(rows)
        .onConflictDoNothing({
          target: [
            schema.agentsTable.organizationId,
            schema.agentsTable.authorId,
          ],
          where: sql`${schema.agentsTable.agentType} = 'mcp_gateway' AND ${schema.agentsTable.isPersonalGateway} = true AND ${schema.agentsTable.deletedAt} IS NULL`,
        })
        .returning({ id: schema.agentsTable.id });

      // This raw INSERT creates the gateways directly in All-tools mode, so
      // pre-fill their exclusion lists in the same transaction — none of them
      // may commit in Auto mode without the pre-fill.
      await AgentExcludedToolModel.prefillManyForAllToolsMode(
        insertedRows.map((row) => row.id),
        tx,
      );

      return insertedRows;
    });

    if (inserted.length < missing.length) {
      logger.warn(
        { missing: missing.length, inserted: inserted.length },
        "bulkBackfillPersonalMcpGateways inserted fewer rows than expected",
      );
    }

    return inserted.length;
  }

  /**
   * Deletes every personal MCP gateway authored by the given user across all
   * organizations. Called from the better-auth user.delete hook so the personal
   * gateway is removed alongside its owner — the agents.author_id FK is
   * ON DELETE SET NULL (to preserve authorship of non-personal agents), so
   * without this the personal gateway row would orphan with author_id = NULL
   * and become permanently undeletable through the API guard.
   */
  static async deletePersonalMcpGatewaysForUser(
    userId: string,
    tx?: Transaction,
  ): Promise<void> {
    await softDelete(
      tx ?? db,
      schema.agentsTable,
      and(
        eq(schema.agentsTable.authorId, userId),
        eq(schema.agentsTable.agentType, "mcp_gateway"),
        eq(schema.agentsTable.isPersonalGateway, true),
      ),
    );
  }

  /**
   * Soft-delete an author's private chat agents and MCP gateways when their
   * membership ends. Left behind, `agents.author_id` is `set null` and the row
   * shows as "Owner unavailable" with no one to use it.
   */
  static async deletePersonalAgentsForUser(params: {
    userId: string;
    organizationId?: string;
    tx?: Transaction;
  }): Promise<number> {
    const table = schema.agentsTable;
    return await softDelete(
      params.tx ?? db,
      table,
      and(
        eq(table.authorId, params.userId),
        params.organizationId
          ? eq(table.organizationId, params.organizationId)
          : undefined,
        or(
          and(
            eq(table.agentType, "agent"),
            // SPDX-SnippetBegin
            // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
            // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
            ResourcePermissionPolicyModel.reachesOnlyOwner({
              organizationId: table.organizationId,
              resource: "agent",
              scopeColumn: table.id,
              ownerColumn: table.authorId,
            }),
            // SPDX-SnippetEnd
          ),
          and(
            eq(table.agentType, "mcp_gateway"),
            // The auto-created personal gateway has its own lifecycle:
            // deletePersonalMcpGatewaysForUser.
            eq(table.isPersonalGateway, false),
            // SPDX-SnippetBegin
            // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
            // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
            ResourcePermissionPolicyModel.reachesOnlyOwner({
              organizationId: table.organizationId,
              resource: "mcpGateway",
              scopeColumn: table.id,
              ownerColumn: table.authorId,
            }),
            // SPDX-SnippetEnd
          ),
        ),
      ),
    );
  }

  /**
   * Resolve a UUID or slug to an agent ID.
   * Checks both the id and slug columns in a single query.
   */
  static async resolveIdFromIdOrSlug(idOrSlug: string): Promise<string | null> {
    const cached = AgentModel.resolveIdCache.get(idOrSlug);
    if (cached !== undefined) {
      return cached;
    }

    // `agents.id` is a uuid column. Casting it to text (`id::text = $1`) so it
    // can be compared against a possibly-non-uuid slug defeats the primary-key
    // index and forces a sequential scan. Instead, only compare against `id`
    // when the input is itself a valid uuid (letting Postgres use the PK index),
    // and otherwise rely solely on the indexed `slug` lookup.
    const matchesIdOrSlug = isUuid(idOrSlug)
      ? or(
          eq(schema.agentsTable.id, idOrSlug),
          eq(schema.agentsTable.slug, idOrSlug),
        )
      : eq(schema.agentsTable.slug, idOrSlug);

    const [row] = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(and(matchesIdOrSlug, notDeleted(schema.agentsTable)))
      .limit(1);

    // Only positive results are cached: a missing mapping must become visible
    // as soon as the agent is created, while a cached hit for a just-deleted
    // agent fails downstream anyway.
    if (row) {
      AgentModel.resolveIdCache.set(idOrSlug, row.id);
    }

    return row?.id ?? null;
  }

  /**
   * Authoritative existence check for the public connection-health endpoint:
   * a fresh, uncached query — a just-deleted gateway must read as missing
   * immediately, so the {@link AgentModel.resolveIdFromIdOrSlug} positive
   * cache (whose staleness its callers tolerate by re-loading the row
   * downstream) is deliberately not used here. Type-scoped so a proxy ref
   * can never pass as a gateway or vice versa.
   */
  static async existsByIdOrSlugAndType(params: {
    idOrSlug: string;
    agentType: AgentType;
  }): Promise<boolean> {
    const { idOrSlug, agentType } = params;
    const matchesIdOrSlug = isUuid(idOrSlug)
      ? or(
          eq(schema.agentsTable.id, idOrSlug),
          eq(schema.agentsTable.slug, idOrSlug),
        )
      : eq(schema.agentsTable.slug, idOrSlug);

    const [row] = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(
        and(
          matchesIdOrSlug,
          eq(schema.agentsTable.agentType, agentType),
          notDeleted(schema.agentsTable),
        ),
      )
      .limit(1);

    return row !== undefined;
  }

  /**
   * Clone an agent and all its associations.
   * Returns the newly created agent.
   */
  static async cloneAgent(params: {
    initialGrants?: ResourcePermissionGrant[];
    sourceId: string;
    userId: string;
    /** Visibility for the clone; defaults to copying the source's scope. */
    scope?: AgentScope;
    /** Teams for a team-scoped clone; defaults to the source's teams. */
    teams?: string[];
  }): Promise<Agent> {
    const { sourceId, userId } = params;

    const sourceAgent = await AgentModel.findById(sourceId, userId, true);
    if (!sourceAgent) {
      throw new Error("Source agent not found");
    }

    const cloneScope = params.scope ?? sourceAgent.scope;
    // Omit teams if scope is not 'team' — scope takes precedence
    const cloneTeams =
      cloneScope === "team"
        ? (params.teams ?? sourceAgent.teams.map((t) => t.id))
        : [];

    let created: Agent | null = null;
    try {
      created = await AgentModel.create(
        {
          organizationId: sourceAgent.organizationId,
          agentType: sourceAgent.agentType,
          scope: cloneScope,
          teams: cloneTeams,
          labels: sourceAgent.labels,
          knowledgeBaseIds: sourceAgent.knowledgeBaseIds ?? [],
          connectorIds: sourceAgent.connectorIds ?? [],
          suggestedPrompts: sourceAgent.suggestedPrompts ?? [],
          name: `Copy of ${sourceAgent.name}`,
          systemPrompt: sourceAgent.systemPrompt,
          description: sourceAgent.description,
          icon: sourceAgent.icon,
          toolExposureMode: sourceAgent.toolExposureMode,
          // Clone in Custom mode first and flip below, so a crash before the
          // exclusions are copied can only leave a fail-closed (assigned-tools-
          // only) clone, never one wide open in Auto mode with no exclusions.
          accessAllTools: false,
          // Skill policy rules are copied below. Start closed so a partial
          // clone can never transiently widen a Manual source to All.
          activationSkillMode: "manual",
          incomingEmailEnabled: sourceAgent.incomingEmailEnabled,
          incomingEmailSecurityMode: sourceAgent.incomingEmailSecurityMode,
          incomingEmailAllowedDomain: sourceAgent.incomingEmailAllowedDomain,
          llmApiKeyId: null,
          modelId: sourceAgent.modelId,
          identityProviderId: null,
          passthroughHeaders: null,
        },
        cloneScope === "personal" ? userId : undefined,
        // Copy the source's assignments verbatim below; don't let create's
        // default assignment force built-ins the source lacked onto the clone.
        {
          skipCreationDefaultTools: true,
          initialPermissionGrants: params.initialGrants,
        },
      );

      await AgentToolModel.cloneAssignments({
        fromAgentId: sourceAgent.id,
        toAgentId: created.id,
      });

      // Copy Auto-tool-mode exclusions. Clones are same-org, so tool ids stay
      // valid; like assignments, exclusions travel with the agent.
      const excludedToolIds = await AgentExcludedToolModel.findToolIdsByAgent(
        sourceAgent.id,
      );
      await AgentExcludedToolModel.replaceForAgent(created.id, excludedToolIds);

      // Same for Auto-mode knowledge-source exclusions: the clone copies the
      // source's knowledge assignments verbatim above, so a source that had
      // turned a knowledge source off would otherwise hand its copy a wider
      // search surface than the original.
      const excludedConnectorIds =
        await AgentExcludedConnectorModel.findConnectorIdsByAgent(
          sourceAgent.id,
        );
      await AgentExcludedConnectorModel.replaceForAgent(
        created.id,
        excludedConnectorIds,
      );

      const excludedSubagentIds =
        await AgentExcludedSubagentModel.findTargetAgentIdsByAgent(
          sourceAgent.id,
        );
      await AgentExcludedSubagentModel.replaceForAgent(
        created.id,
        excludedSubagentIds,
      );

      const activationSkillRules =
        await AgentActivationSkillRuleModel.findByAgent(sourceAgent.id);
      await AgentActivationSkillRuleModel.addRules({
        agentId: created.id,
        rules: activationSkillRules,
      });
      await AgentModel.setActivationSkillPolicyState({
        id: created.id,
        mode: AgentActivationSkillModeSchema.parse(
          sourceAgent.activationSkillMode,
        ),
        revision: activationSkillRules.length > 0 ? 1 : 0,
      });

      // Now that the verbatim exclusions exist, flip an All-tools source's
      // clone on. Skip the pre-fill: the copy above is the authoritative set,
      // and an additive pre-fill would re-add built-ins the source had
      // un-excluded.
      if (sourceAgent.accessAllTools) {
        await AgentModel.update(
          created.id,
          { accessAllTools: true },
          { skipExclusionPrefill: true },
        );
      }
      if (sourceAgent.accessAllSubagents) {
        await AgentModel.update(created.id, { accessAllSubagents: true });
      }

      // Fork last, once the copied assignments and exclusions are in place.
      // create() already forked a version 1 that predates them, and neither
      // cloneAssignments nor replaceForAgent forks; without this a clone of a
      // Custom-mode agent (which skips the update above) would leave version 1
      // — a snapshot with no tools — as the permanent head of a fully
      // configured agent.
      await AgentVersionModel.forkIfChangedBestEffort(created.id);

      const clonedAgent = await AgentModel.findById(created.id, userId, true);
      if (!clonedAgent) {
        throw new Error("Failed to load cloned agent");
      }

      return clonedAgent;
    } catch (error) {
      if (created) {
        try {
          await AgentModel.hardDelete(created.id);
        } catch {
          // ignore cleanup errors
        }
      }
      throw error;
    }
  }

  private static async generateUniqueSlug(name: string): Promise<string> {
    const baseSlug = urlSlugify(name) || "agent";

    const [existing] = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.slug, baseSlug),
          notDeleted(schema.agentsTable),
        ),
      )
      .limit(1);

    if (existing) {
      return `${baseSlug}-${crypto.randomUUID().slice(0, 6)}`;
    }

    return baseSlug;
  }

  private static async insertWithSlugRetry(
    values: typeof schema.agentsTable.$inferInsert,
    permissions: {
      grants?: ResourcePermissionGrant[];
      publishToOrganization?: boolean;
    },
  ) {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (values.agentType === "llm_proxy")
          return await db
            .insert(schema.agentsTable)
            .values(
              await CreatedByModel.forInsert({
                data: { ...values, scope: values.scope ?? "personal" },
                userIdField: "authorId",
              }),
            )
            .returning();
        return await withDbTransaction(async (tx) => {
          const rows = await tx
            .insert(schema.agentsTable)
            .values(
              await CreatedByModel.forInsert({
                data: { ...values, scope: values.scope ?? "personal" },
                userIdField: "authorId",
                transaction: tx,
              }),
            )
            .returning();
          const row = rows[0];
          // An agent outside any organization has nobody to grant access to.
          if (!row.organizationId) return rows;
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          await ResourcePermissionPolicyModel.createInitial({
            tx,
            organizationId: row.organizationId,
            resource: row.agentType === "mcp_gateway" ? "mcpGateway" : "agent",
            scope: row.id,
            grants: permissions.grants,
            authorId: row.authorId,
            publishToOrganization: permissions.publishToOrganization,
          });
          // SPDX-SnippetEnd
          return rows;
        });
      } catch (error: unknown) {
        const isSlugConflict =
          error instanceof Error && error.message.includes("agents_slug_idx");
        if (!isSlugConflict || !values.slug || attempt === maxRetries - 1) {
          throw error;
        }
        const baseSlug = values.slug.replace(/-[a-f0-9]{6}$/, "");
        values = {
          ...values,
          slug: `${baseSlug}-${crypto.randomUUID().slice(0, 6)}`,
        };
      }
    }
    throw new Error("Unreachable");
  }
  /**
   * Identity of an agent for the audit trail, and nothing else — id, name, and
   * type. The permanent-delete route uses this instead of
   * {@link findByIdForAudit} because a purge is audited by identity only: the
   * point of the action is to destroy the config, so an audit row that
   * preserved a full snapshot of it would defeat the request.
   *
   * Does not filter soft-deleted rows — the purge target is by definition in
   * the trash, so the filtered read paths cannot serve this.
   */
  static async findIdentityForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        agentType: schema.agentsTable.agentType,
      })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.id, id),
          eq(schema.agentsTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select()
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.id, id),
          eq(schema.agentsTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!row) return null;

    // Fetch relational data so audit diffs capture tool/KB/team changes —
    // not just main-table columns.  Each sub-query is lightweight (index
    // lookup by agent_id) and the parallel fetch keeps latency low.
    const [
      tools,
      teams,
      labels,
      knowledgeBaseIds,
      connectorIds,
      excludedConnectorIds,
      delegations,
      excludedSubagentIds,
      skillIds,
      excludedSkillIds,
      activationSkillRules,
      excludedToolIds,
      hookRows,
      suggestedPrompts,
      modelRows,
      keyRows,
    ] = await Promise.all([
      AgentToolModel.getToolsForAgent(id),
      AgentTeamModel.getTeamDetailsForAgent(id),
      AgentLabelModel.getLabelsForAgent(id),
      AgentKnowledgeBaseModel.getKnowledgeBaseIds(id),
      AgentConnectorAssignmentModel.getConnectorIds(id),
      AgentExcludedConnectorModel.findConnectorIdsByAgent(id),
      AgentToolModel.getDelegationTargets(id),
      AgentExcludedSubagentModel.findTargetAgentIdsByAgent(id),
      // The skill-publication routes audit through this snapshot too, so the
      // published set and its Auto-mode exclusions must diff like any other
      // relational field — publishing a skill to a gateway's token holders is
      // exactly the change the log exists to show.
      AgentSkillModel.findSkillIdsByAgent(id),
      AgentExcludedSkillModel.findSkillIdsByAgent(id),
      AgentActivationSkillRuleModel.findByAgent(id),
      AgentExcludedToolModel.findToolIdsByAgent(id),
      // Hook IDENTITY only, never `content`: a hook edit must produce a
      // non-empty diff, but script bodies would ride along on every unrelated
      // agent audit record.
      db
        .select({
          event: schema.hookFilesTable.event,
          fileName: schema.hookFilesTable.fileName,
          enabled: schema.hookFilesTable.enabled,
        })
        .from(schema.hookFilesTable)
        .where(eq(schema.hookFilesTable.agentId, id)),
      AgentSuggestedPromptModel.getForAgent(id),
      // Resolve the live modelId FK to its human-readable identity so a model
      // change surfaces as a real diff — the legacy llmModel text column is
      // deprecated (never written) and would always read null.
      row.modelId
        ? db
            .select({ externalId: schema.modelsTable.externalId })
            .from(schema.modelsTable)
            .where(eq(schema.modelsTable.id, row.modelId))
            .limit(1)
        : Promise.resolve([]),
      // The model and its API key are set as a pair; capture a redacted key
      // identity (id/name/scope + provider) so an LLM-config change is legible
      // and a swap between two same-provider keys still diffs — without ever
      // touching key material (secretId is excluded).
      row.llmApiKeyId
        ? db
            .select({
              id: schema.llmProviderApiKeysTable.id,
              name: schema.llmProviderApiKeysTable.name,
              scope: schema.llmProviderApiKeysTable.scope,
              provider: schema.llmProviderApiKeysTable.provider,
            })
            .from(schema.llmProviderApiKeysTable)
            .where(eq(schema.llmProviderApiKeysTable.id, row.llmApiKeyId))
            .limit(1)
        : Promise.resolve([]),
    ]);

    const delegationTargets = [...delegations]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((d) => ({ id: d.id, name: d.name }));

    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    return {
      resourcePermissions:
        (
          await ResourcePermissionPolicyModel.find({
            organizationId,
            resource: row.agentType === "mcp_gateway" ? "mcpGateway" : "agent",
            scope: row.id,
          })
        )?.grants ?? [],
      id: row.id,
      name: row.name,
      organizationId: row.organizationId,
      agentType: row.agentType,
      authorId: row.authorId,
      createdByServiceAccountId: row.createdByServiceAccountId,
      scope: row.scope,
      description: row.description ?? null,
      systemPrompt: row.systemPrompt ?? null,
      slug: row.slug ?? null,
      isDefault: row.isDefault,
      model: modelRows[0]?.externalId ?? null,
      llmProvider: keyRows[0]?.provider ?? null,
      llmApiKey: keyRows[0]
        ? {
            id: keyRows[0].id,
            name: keyRows[0].name,
            scope: keyRows[0].scope,
          }
        : null,
      icon: row.icon ?? null,
      toolExposureMode: row.toolExposureMode,
      accessAllTools: row.accessAllTools,
      accessAllSubagents: row.accessAllSubagents,
      accessAllSkills: row.accessAllSkills,
      activationSkillMode: row.activationSkillMode,
      activationSkillPolicyRevision: row.activationSkillPolicyRevision,
      // Audit readers may not have access to every skill named by a saved
      // policy. Counts make the policy change visible without disclosing an
      // unavailable native id, external URI, or plugin path.
      activationSkillRuleCounts: {
        allowed: activationSkillRules.filter(
          (rule) => rule.disposition === "allow",
        ).length,
        excluded: activationSkillRules.filter(
          (rule) => rule.disposition === "exclude",
        ).length,
      },
      // passthrough_headers is a text[] of header NAMES (no values), so it is
      // safe to capture verbatim.
      passthroughHeaders: [...(row.passthroughHeaders ?? [])].sort(),
      identityProviderId: row.identityProviderId ?? null,
      environmentId: row.environmentId ?? null,
      incomingEmailEnabled: row.incomingEmailEnabled,
      incomingEmailSecurityMode: row.incomingEmailSecurityMode,
      incomingEmailAllowedDomain: row.incomingEmailAllowedDomain ?? null,
      builtInAgentConfig: row.builtInAgentConfig ?? null,
      runtime: row.runtime
        ? {
            image: row.runtime.image,
            command: row.runtime.command,
            backend: row.runtime.backend,
            steerMode: row.runtime.steerMode,
            privileged: row.runtime.privileged,
            resources: row.runtime.resources,
            environmentKeys: (row.runtime.environment ?? [])
              .map((entry) => entry.key)
              .sort(),
            credentials: (row.runtime.credentials ?? [])
              .map(({ key, credentialId, scope, label, required }) => ({
                key,
                credentialId: credentialId ?? null,
                scope,
                label,
                required,
              }))
              .sort((a, b) => a.key.localeCompare(b.key)),
            ttlHours: row.runtime.ttlHours,
            maxCostUsd: row.runtime.maxCostUsd ?? null,
            idleTimeoutMinutes: row.runtime.idleTimeoutMinutes,
          }
        : null,
      // A reference id is safe to audit and changes on every shared-secret
      // rotation, producing a non-empty diff without recording secret values.
      runtimeCredentialRevision: row.runtimeSecretId ?? null,
      tools: tools.map((t) => t.name).sort(),
      knowledgeBaseIds: [...knowledgeBaseIds].sort(),
      connectorIds: [...connectorIds].sort(),
      excludedConnectorIds: [...excludedConnectorIds].sort(),
      teams: teams.map((t) => t.name).sort(),
      labels: labels.sort(),
      delegationTargets,
      excludedSubagentIds: [...excludedSubagentIds].sort(),
      skillIds: [...skillIds].sort(),
      excludedSkillIds: [...excludedSkillIds].sort(),
      excludedToolIds: [...excludedToolIds].sort(),
      hooks: hookRows
        .map((h) => `${h.event}/${h.fileName}${h.enabled ? "" : " (disabled)"}`)
        .sort(),
      suggestedPrompts,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
    // SPDX-SnippetEnd
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  private static async buildRosterWhere(params: {
    userId?: string;
    isAgentAdmin?: boolean;
    options?: AgentRosterOptions;
  }) {
    const { userId, isAgentAdmin, options } = params;
    const principals = userId
      ? await ResourcePermissionSubjectModel.resolvePrincipals({
          userId,
          organizationId: options?.authorization?.organizationId,
        })
      : [];
    // Build where conditions
    const whereConditions: SQL[] = [
      getAgentStatusCondition(options?.status ?? "active"),
      ...(userId ? [agentListFence(principals)] : []),
    ];
    if (options?.authorization) {
      if (!userId) return sql`false`;
      const { organizationId, baseReadTypes } = options.authorization;
      whereConditions.push(
        eq(schema.agentsTable.organizationId, organizationId),
      );
      if (options.status !== "deleted") {
        whereConditions.push(
          or(
            inArray(schema.agentsTable.agentType, baseReadTypes),
            explicitAgentReadCondition(principals),
          ) as SQL,
        );
      }
    }

    // Filter by agentTypes if specified (array of types)
    if (options?.agentTypes && options.agentTypes.length > 0) {
      whereConditions.push(
        inArray(schema.agentsTable.agentType, options.agentTypes),
      );
    }
    // Filter by agentType if specified (single type, backwards compatible)
    else if (options?.agentType !== undefined) {
      whereConditions.push(eq(schema.agentsTable.agentType, options.agentType));
    }

    if (options?.onlyEnforcingMissingCredentials) {
      whereConditions.push(
        ne(schema.agentsTable.missingCredentialBehavior, "allow"),
      );
    }

    const isChatView = options?.view === "chat";
    const builtInName = sql<string>`coalesce(${schema.agentsTable.builtInAgentConfig}->>'name', '')`;
    // Chat exposes its system assistant through the same authorized roster;
    // platform subagents remain excluded from ordinary chat selection.
    if (options?.excludeBuiltIn || !isAgentAdmin || isChatView) {
      const visibleAgents = [eq(schema.agentsTable.builtIn, false)];
      if (isChatView && enterpriseTier.isOpenappaActive()) {
        visibleAgents.push(eq(builtInName, BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG));
      }
      whereConditions.push(or(...visibleAgents) as SQL);
    }

    // Filter by scope if specified
    if (options?.scope) {
      whereConditions.push(agentAudienceIs(options.scope));
    }

    // Keep oversight-only personal agents hidden, while honoring explicit shares.
    if (options?.excludeOtherPersonalAgents && userId) {
      whereConditions.push(
        AgentModel.notOthersPersonalCondition({ userId, principals }),
      );
    }

    // Apply access control filtering for non-agent admins
    if (userId && !isAgentAdmin) {
      whereConditions.push(
        inArray(
          schema.agentsTable.id,
          accessibleAgentIdsQuery({ userId, isAgentAdmin: false, principals }),
        ),
      );
    }

    if (options?.ids !== undefined) {
      whereConditions.push(
        idArrayCondition(schema.agentsTable.id, options.ids),
      );
    }

    return and(...whereConditions);
  }
  // SPDX-SnippetEnd
  private static async findChatRosterRows(
    where: SQL | undefined,
  ): Promise<ChatAgentRoster[]> {
    const agents = await db
      .select(CHAT_ROSTER_COLUMNS)
      .from(schema.agentsTable)
      .where(where);
    await AgentModel.populateGrantedScope(agents);
    return agents;
  }

  private static async findRosterPageIds(params: {
    where: SQL | undefined;
    sortBy?: "name" | "createdAt" | "chat";
    pagination: CursorQuery;
  }) {
    const table = schema.agentsTable;
    const cursor = decodeCursor(params.pagination.cursor);
    const nameOrder = params.sortBy === "name";
    const chatOrder = params.sortBy === "chat";
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    const chatRank = chatOrder
      ? sql<number>`CASE ${ResourcePermissionPolicyModel.sharedAudience({ organizationId: table.organizationId, resource: "agent", scopeColumn: table.id, ownerColumn: table.authorId })} WHEN 'organization' THEN 2 WHEN 'team' THEN 1 ELSE 0 END`
      : sql<number>`0`;
    // SPDX-SnippetEnd
    let chatPosition: { rank: number; name: string } | undefined;
    if (chatOrder && cursor) {
      try {
        const parsed = ChatRosterCursorPositionSchema.safeParse(
          JSON.parse(cursor.value),
        );
        if (parsed.success) chatPosition = parsed.data;
      } catch {
        /* An invalid cursor restarts the page. */
      }
    }
    const validCursor =
      cursor &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        cursor.id,
      ) &&
      (chatOrder
        ? chatPosition !== undefined
        : nameOrder || !Number.isNaN(Date.parse(cursor.value)))
        ? cursor
        : null;
    const boundary = validCursor
      ? chatOrder && chatPosition
        ? sql`(${chatRank}, ${table.name} COLLATE "C", ${table.id}) > (${chatPosition.rank}, ${chatPosition.name} COLLATE "C", ${validCursor.id}::uuid)`
        : nameOrder
          ? sql`(${table.name} COLLATE "C", ${table.id}) > (${validCursor.value} COLLATE "C", ${validCursor.id}::uuid)`
          : sql`(${table.createdAt}, ${table.id}) < (${validCursor.value}::timestamp, ${validCursor.id}::uuid)`
      : undefined;
    const rows = await db
      .select({
        id: table.id,
        name: table.name,
        cursorValue: sql<string>`${table.createdAt}::text`,
        chatRank,
      })
      .from(table)
      .where(and(params.where, boundary))
      .orderBy(
        ...(chatOrder
          ? [asc(chatRank), asc(sql`${table.name} COLLATE "C"`), asc(table.id)]
          : nameOrder
            ? [asc(sql`${table.name} COLLATE "C"`), asc(table.id)]
            : [desc(table.createdAt), desc(table.id)]),
      )
      .limit(params.pagination.limit + 1);
    return createCursorPaginatedResult(rows, params.pagination, (row) => ({
      id: row.id,
      value: chatOrder
        ? JSON.stringify({ rank: row.chatRank, name: row.name })
        : nameOrder
          ? row.name
          : row.cursorValue,
    }));
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  private static async buildOptionWhere(params: {
    userId: string;
    isAgentAdmin: boolean;
    options: AgentRosterOptions;
    filters: AgentOptionFilters;
  }) {
    const table = schema.agentsTable;
    const rosterWhere = await AgentModel.buildRosterWhere(params);
    const filters: (SQL | undefined)[] = [rosterWhere];
    const query = params.filters;
    if (query.onlyOwnPersonalAgents)
      filters.push(
        or(
          not(optionScopeCondition("personal")),
          eq(table.authorId, params.userId),
        ),
      );
    if (query.excludeIds?.length)
      filters.push(not(idArrayCondition(table.id, query.excludeIds)));
    if (query.runtimeCommand !== undefined)
      filters.push(
        sql`${table.runtime}->'command'->>0 = ${query.runtimeCommand}`,
      );
    if (query.exactName !== undefined)
      filters.push(eq(table.name, query.exactName));
    if (query.authorId !== undefined)
      filters.push(eq(table.authorId, query.authorId));
    if (query.excludePersonalGateways)
      filters.push(eq(table.isPersonalGateway, false));
    if (query.search) filters.push(optionSearchCondition(query));
    if (query.audienceVisibility !== undefined) {
      const org = optionScopeCondition("org");
      switch (query.audienceVisibility) {
        case "organization":
          filters.push(org);
          break;
        case "team":
          filters.push(
            or(
              org,
              and(
                optionScopeCondition("team"),
                (query.audienceTeamIds?.length ?? 0) > 0
                  ? optionRecipientCondition(
                      "team",
                      query.audienceTeamIds ?? [],
                    )
                  : sql`false`,
              ),
            ),
          );
          break;
        case "user":
          filters.push(
            or(
              org,
              and(
                optionScopeCondition("personal"),
                optionRecipientCondition("user", query.audienceUserIds ?? []),
              ),
            ),
          );
          break;
        case "none":
          if (!query.audienceEditorIsOwner) filters.push(org);
          break;
      }
    }
    return { where: and(...filters), rosterWhere };
  }
  // SPDX-SnippetEnd

  /** Select only selector fields and hydrate their presentation in batches. */
  private static async findOptionRows(
    where: SQL | undefined,
  ): Promise<AgentOption[]> {
    const table = schema.agentsTable;
    const rows = await db
      .select({
        id: table.id,
        name: table.name,
        slug: table.slug,
        agentType: table.agentType,
        icon: CHAT_AGENT_ROW_COLUMNS.icon,
        scope: table.scope,
        authorId: table.authorId,
        isPersonalGateway: table.isPersonalGateway,
        runtime: table.runtime,
        description: table.description,
        organizationId: table.organizationId,
        createdByServiceAccountId: table.createdByServiceAccountId,
      })
      .from(table)
      .where(where);
    const agents = rows.map((row) => ({
      ...row,
      teams: [] as { id: string; name: string }[],
      users: [] as AgentOption["users"],
      authorName: null as string | null,
      authorEmail: null as string | null,
      createdBy: null as Agent["createdBy"],
    }));
    const agentIds = agents.map((agent) => agent.id);
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    const policies = await ResourcePermissionPolicyModel.findObjectPolicies({
      resources: ["agent", "mcpGateway"],
      scopes: agentIds,
    });
    const [recipients] = await Promise.all([
      ResourcePermissionPolicyModel.findReadRecipientDetails({
        resources: ["agent", "mcpGateway"],
        scopes: agentIds,
        policies,
        excludeUserIds: new Map(
          agents.map((agent) => [agent.id, agent.authorId]),
        ),
      }),
      AgentModel.populateGrantedScope(agents, policies),
      AgentModel.populateAuthorNames(agents),
    ]);
    for (const agent of agents) {
      const details = recipients.get(agent.id);
      agent.teams = (details?.teams ?? []).map(({ id, name }) => ({
        id,
        name,
      }));
      agent.users = (details?.users ?? []).map(({ id }) => ({ id }));
    }
    // SPDX-SnippetEnd
    return agents;
  }
}

const PERSONAL_MCP_GATEWAY_DESCRIPTION =
  "All MCP servers you install are automatically connected to this gateway.";

type AgentRecordStatus = "active" | "deleted";

function getAgentStatusCondition(status: AgentRecordStatus): SQL {
  return status === "deleted"
    ? isNotNull(schema.agentsTable.deletedAt)
    : notDeleted(schema.agentsTable);
}

function getAgentTypeLabel(agentType: AgentType): string {
  switch (agentType) {
    case "mcp_gateway":
      return "MCP gateway";
    case "llm_proxy":
      return "LLM proxy";
    case "agent":
      return "agent";
    case "profile":
      return "profile";
  }
}

function errorMentions(error: unknown, needle: string): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes(needle)) return true;
  return errorMentions((error as { cause?: unknown }).cause, needle);
}

function isQueryKnowledgeSourcesTool(toolName: string): boolean {
  return (
    parseFullToolName(toolName).toolName ===
    TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME
  );
}

function hasKnowledgeSources(
  agent: Pick<Agent, "knowledgeBaseIds" | "connectorIds">,
): boolean {
  return agent.knowledgeBaseIds.length > 0 || agent.connectorIds.length > 0;
}

/**
 * Ceiling for {@link AgentModel.purge}'s transaction, ten times the pool-wide
 * default. See that method for why the default is too low and why this is a
 * finite number rather than no limit at all.
 */
const PURGE_STATEMENT_TIMEOUT_MS = 300_000;

/**
 * Column set for the slim {@link AgentToolRef} embedded in agent payloads.
 * Deliberately excludes `parameters` and the other wide tool columns so agent
 * list queries don't drag every assigned tool's JSON schema out of the
 * database once per assignment; the dedicated per-agent tools endpoints serve
 * full tool definitions.
 */
const agentToolRefColumns = {
  id: schema.toolsTable.id,
  agentId: schema.toolsTable.agentId,
  catalogId: schema.toolsTable.catalogId,
  delegateToAgentId: schema.toolsTable.delegateToAgentId,
  delegateToA2aConnectionId: schema.toolsTable.delegateToA2aConnectionId,
  name: schema.toolsTable.name,
  rawName: schema.toolsTable.rawName,
  description: schema.toolsTable.description,
};

/**
 * The later of two nullable timestamps, or null when both are absent. Used to
 * fold the two halves of "last used" into the single moment a row reports.
 */
function mostRecent(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export default AgentModel;

// The chat roster appears before the picker opens. Emoji and short URL icons
// are cheap enough to keep inline; base64 image data is fetched only for the
// selected agent through the existing detail endpoint.
const MAX_INLINE_CHAT_AGENT_ICON_CHARS = 1_024;
const CHAT_AGENT_ROW_COLUMNS = {
  ...getTableColumns(schema.agentsTable),
  systemPrompt: sql<string | null>`null`,
  icon: sql<string | null>`case
    when length(${schema.agentsTable.icon}) <= ${MAX_INLINE_CHAT_AGENT_ICON_CHARS}
      then ${schema.agentsTable.icon}
    else null
  end`,
};

const CHAT_ROSTER_COLUMNS = {
  id: schema.agentsTable.id,
  organizationId: schema.agentsTable.organizationId,
  name: schema.agentsTable.name,
  description: schema.agentsTable.description,
  icon: CHAT_AGENT_ROW_COLUMNS.icon,
  scope: schema.agentsTable.scope,
  authorId: schema.agentsTable.authorId,
  agentType: schema.agentsTable.agentType,
  builtIn: schema.agentsTable.builtIn,
  builtInAgentConfig: schema.agentsTable.builtInAgentConfig,
  runtime: schema.agentsTable.runtime,
  modelId: schema.agentsTable.modelId,
  llmApiKeyId: schema.agentsTable.llmApiKeyId,
};

function explicitAgentReadCondition(principals: GrantPrincipal[]) {
  const table = schema.agentsTable;
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  return or(
    and(
      inArray(table.agentType, ["agent", "profile"]),
      ResourcePermissionPolicyModel.grantConditionForAny({
        principals,
        organizationColumn: table.organizationId,
        resource: "agent",
        scopeColumn: table.id,
        action: "read",
      }),
    ),
    and(
      eq(table.agentType, "mcp_gateway"),
      ResourcePermissionPolicyModel.grantConditionForAny({
        principals,
        organizationColumn: table.organizationId,
        resource: "mcpGateway",
        scopeColumn: table.id,
        action: "read",
      }),
    ),
  );
  // SPDX-SnippetEnd
}

/**
 * The list fence for every agent kind: agents and MCP gateways by their read
 * grants, and LLM proxies unfenced here because they have no grant namespace
 * of their own — the caller's own conditions decide those.
 */
function agentListFence(principals: GrantPrincipal[]): SQL {
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  return or(
    eq(schema.agentsTable.agentType, "llm_proxy"),
    explicitAgentReadCondition(principals),
  ) as SQL;
  // SPDX-SnippetEnd
}

/**
 * Shared accessible-ID query. List filters embed this exact authorization set
 * instead of fetching the whole roster and sending its IDs back as parameters,
 * so selective filters such as pins can narrow the work in the database.
 */
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
function accessibleAgentIdsQuery(params: {
  userId: string;
  isAgentAdmin: boolean;
  principals: GrantPrincipal[];
}) {
  return db
    .select({ id: schema.agentsTable.id })
    .from(schema.agentsTable)
    .where(
      and(
        notDeleted(schema.agentsTable),
        or(
          explicitAgentReadCondition(params.principals),
          params.isAgentAdmin ? sql`true` : undefined,
          organizationLlmProxyCondition(params.userId),
        ),
      ),
    );
}
// SPDX-SnippetEnd

/**
 * The organization's LLM Proxy, for a member of that organization. A proxy has
 * no grant namespace of its own: the one row every proxy request resolves to
 * serves the whole organization, and the retired per-user proxy rows it
 * replaced are reached by nobody but an administrator.
 */
function organizationLlmProxyCondition(userId: string): SQL {
  const table = schema.agentsTable;
  return and(
    eq(table.agentType, "llm_proxy"),
    eq(table.isDefault, true),
    sql`EXISTS (SELECT 1 FROM member proxy_member WHERE proxy_member.organization_id = ${table.organizationId} AND proxy_member.user_id = ${userId})`,
  ) as SQL;
}

/**
 * {@link ResourcePermissionPolicyModel.audienceIs} for every agent kind. The
 * organization's LLM proxy has no grant namespace and serves the whole
 * organization, so it always reads as `org`.
 */
function agentAudienceIs(audience: "personal" | "team" | "org"): SQL {
  const table = schema.agentsTable;
  const byResource = (resource: "agent" | "mcpGateway") =>
    ResourcePermissionPolicyModel.audienceIs({
      organizationId: table.organizationId,
      resource,
      scopeColumn: table.id,
      ownerColumn: table.authorId,
      audience,
    });
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  return or(
    and(inArray(table.agentType, ["agent", "profile"]), byResource("agent")),
    and(eq(table.agentType, "mcp_gateway"), byResource("mcpGateway")),
    and(
      eq(table.agentType, "llm_proxy"),
      audience === "org" ? sql`true` : sql`false`,
    ),
  ) as SQL;
  // SPDX-SnippetEnd
}

/**
 * {@link ResourcePermissionPolicyModel.accessRelationCondition} for every
 * agent kind. The organization's LLM proxy has no grant namespace and serves
 * the whole organization, so it is always `org`, counts as shared with the
 * organization, and has no owner.
 */
function agentAccessCondition(params: {
  userId: string;
  principals: GrantPrincipal[];
  selection: ResourceAccessSelection;
}): SQL | undefined {
  const { relations, sharedWith, ownerIds } = params.selection;
  const table = schema.agentsTable;
  const subjects = params.principals.flatMap((principal) => principal.subjects);
  const byResource = (resource: "agent" | "mcpGateway") =>
    ResourcePermissionPolicyModel.accessRelationCondition({
      organizationId: table.organizationId,
      resource,
      scopeColumn: table.id,
      ownerColumn: table.authorId,
      userId: params.userId,
      subjects,
      ...params.selection,
    });
  const agentCondition = byResource("agent");
  if (!agentCondition) return undefined;
  const llmProxyMatches =
    (!relations?.length || relations.includes("org")) &&
    (!sharedWith?.length ||
      sharedWith.some((subject) => subject.type === "organization")) &&
    !ownerIds?.length;
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  return or(
    and(inArray(table.agentType, ["agent", "profile"]), agentCondition),
    and(eq(table.agentType, "mcp_gateway"), byResource("mcpGateway")),
    and(
      eq(table.agentType, "llm_proxy"),
      llmProxyMatches ? sql`true` : sql`false`,
    ),
  ) as SQL;
  // SPDX-SnippetEnd
}

/**
 * The "Show" filter for external A2A agents, read from their own policies like
 * internal agents.
 */
async function externalAgentAccessCondition(params: {
  userId: string;
  organizationId?: string;
  selection: ResourceAccessSelection;
}): Promise<SQL | undefined> {
  const table = schema.a2aRemoteAgentsTable;
  const principals = await ResourcePermissionSubjectModel.resolvePrincipals({
    userId: params.userId,
    organizationId: params.organizationId,
  });
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  return ResourcePermissionPolicyModel.accessRelationCondition({
    organizationId: table.organizationId,
    resource: "externalAgent",
    scopeColumn: table.id,
    ownerColumn: table.authorId,
    userId: params.userId,
    subjects: principals.flatMap((principal) => principal.subjects),
    ...params.selection,
  });
  // SPDX-SnippetEnd
}

/** An external agent's audience, read from its own policy. */
function externalAgentAudienceIs(audience: "personal" | "team" | "org"): SQL {
  const table = schema.a2aRemoteAgentsTable;
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  return ResourcePermissionPolicyModel.audienceIs({
    organizationId: table.organizationId,
    resource: "externalAgent",
    scopeColumn: table.id,
    ownerColumn: table.authorId,
    audience,
  });
  // SPDX-SnippetEnd
}

/** The alphabetically first team an external agent's policy grants read to. */
function externalAgentFirstGrantedTeamName() {
  const table = schema.a2aRemoteAgentsTable;
  return sql<string | null>`(
    SELECT min(granted_team.name)
    FROM resource_permission_policies team_policy,
      jsonb_array_elements(team_policy.grants) team_entry,
      team granted_team
    WHERE team_policy.organization_id = ${table.organizationId}
      AND team_policy.resource = 'externalAgent'
      AND team_policy.scope = ${table.id}::text
      AND (team_entry->'actions') ? 'read'
      AND team_entry->'subject'->>'type' = 'team'
      AND granted_team.id = team_entry->'subject'->>'id'
  )`;
}

/** Agents whose own policy grants read to any of `teamIds`. */
function agentGrantsReadToAnyTeam(teamIds: string[]): SQL {
  const table = schema.agentsTable;
  const byResource = (resource: "agent" | "mcpGateway") =>
    ResourcePermissionPolicyModel.grantsReadToAnyTeam({
      organizationId: table.organizationId,
      resource,
      scopeColumn: table.id,
      teamIds,
    });
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  return or(
    and(inArray(table.agentType, ["agent", "profile"]), byResource("agent")),
    and(eq(table.agentType, "mcp_gateway"), byResource("mcpGateway")),
  ) as SQL;
  // SPDX-SnippetEnd
}

/** The first (by name) team an agent's own policy grants read to. */
function agentFirstGrantedTeamName() {
  return sql<string | null>`(
    SELECT min(granted_team_name.name) FROM team granted_team_name
    WHERE granted_team_name.id = ANY(${agentGrantedTeamIds()})
  )`;
}

/** The teams an agent's own policy grants read to, as a SQL text array. */
function agentGrantedTeamIds() {
  const table = schema.agentsTable;
  return sql<string[]>`coalesce(array(
    SELECT DISTINCT granted_team.subject_id FROM (
      SELECT team_entry->'subject'->>'id' AS subject_id
      FROM resource_permission_policies team_policy,
        jsonb_array_elements(team_policy.grants) team_entry
      WHERE team_policy.organization_id = ${table.organizationId}
        AND team_policy.resource = CASE WHEN ${table.agentType} = 'mcp_gateway' THEN 'mcpGateway' ELSE 'agent' END
        AND team_policy.scope = ${table.id}::text
        AND (team_entry->'actions') ? 'read'
        AND team_entry->'subject'->>'type' = 'team'
    ) granted_team
  ), array[]::text[])`;
}

// ===
// Agent catalog access prefilter
// ===

/**
 * The agents the catalog's "Show" filter can keep, as one id set the database
 * builds once, so the plan starts from those rows instead of testing the
 * relation filter on every agent. An administrator reads every agent through
 * the `*` grant, so that test otherwise ran against every other member's
 * personal agent.
 *
 * The set is a superset of what the relations keep: `mine` needs the caller
 * as author; `shared` needs a read grant to one of the caller's teams or own
 * ids; `org` needs a read grant to the organization or a role. The set holds
 * exactly the authored agents and the agents whose policy has such a grant,
 * and the exact relation filter stays ANDed on top, so the prefilter can only
 * remove rows that filter removes too. It is undefined where no such set
 * exists: a selection with `others` (rows nobody is granted), or with no or
 * every relation (no relation filter at all). The catalog's regular branch
 * lists only `agent` rows, so only `agent` policies are read.
 */
async function catalogAccessCandidateIds(params: {
  organizationId: string | undefined;
  userId: string;
  selection: ResourceAccessSelection | undefined;
  includeBuiltIn: boolean;
}): Promise<SQL | undefined> {
  const selected = new Set(
    params.selection?.relations ?? RESOURCE_ACCESS_RELATIONS,
  );
  if (
    !params.organizationId ||
    selected.size === 0 ||
    selected.has("others") ||
    RESOURCE_ACCESS_RELATIONS.every((relation) => selected.has(relation))
  )
    return undefined;
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  const grantedSubjects: Array<{ type: string; id?: string }> = [];
  if (selected.has("shared")) {
    const principals = await ResourcePermissionSubjectModel.resolvePrincipals({
      userId: params.userId,
      organizationId: params.organizationId,
    });
    for (const subject of principals.flatMap(({ subjects }) => subjects)) {
      if (subject.type === "team") grantedSubjects.push(subject);
      // The relation matches the caller's own ids under either self type.
      if (subject.type === "user" || subject.type === "serviceAccount")
        grantedSubjects.push(
          { type: "user", id: subject.id },
          { type: "serviceAccount", id: subject.id },
        );
    }
  }
  // Any organization or role grant makes the audience `org`.
  if (selected.has("org"))
    grantedSubjects.push({ type: "organization" }, { type: "role" });

  const table = schema.agentsTable;
  const sources: SQL[] = [];
  if (selected.has("mine"))
    sources.push(
      sql`SELECT own_agent.id FROM ${table} own_agent WHERE own_agent.author_id = ${params.userId}`,
    );
  if (grantedSubjects.length > 0) {
    const patterns = grantedSubjects.map(
      (subject) => sql`${JSON.stringify([{ subject, actions: ["read"] }])}`,
    );
    // Policy scopes are object ids or `*`; only object ids name an agent.
    sources.push(sql`SELECT CASE WHEN access_policy.scope ~* ${UUID_PATTERN}
        THEN access_policy.scope::uuid END
      FROM resource_permission_policies access_policy
      WHERE access_policy.organization_id = ${params.organizationId}
        AND access_policy.resource = 'agent'
        AND access_policy.grants @> ANY(ARRAY[${sql.join(patterns, sql`, `)}]::jsonb[])`);
  }
  if (params.includeBuiltIn)
    sources.push(
      sql`SELECT built_in_agent.id FROM ${table} built_in_agent WHERE built_in_agent.organization_id = ${params.organizationId} AND built_in_agent.built_in`,
    );
  if (sources.length === 0) return sql<boolean>`false`;
  return sql<boolean>`${table.id} IN (${sql.join(sources, sql` UNION ALL `)})`;
  // SPDX-SnippetEnd
}

const UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

// ===
// Agent catalog sorting
// ===

const CATALOG_COMPUTED_SORTS = new Set<string>([
  "toolsCount",
  "subagentsCount",
  "lastUsedAt",
]);

/**
 * The value a catalog row sorts on for the columns the list computes, as each
 * cell shows it: "All" ranks above any count, and an external agent, which
 * has neither tools nor a last use here, sorts below every internal agent.
 * Other sorts read a plain column, so this is a constant for them and costs
 * nothing per row.
 */
function catalogSortValue(sortBy: string | undefined): {
  regular: SQL;
  external: SQL;
} {
  const assigned = (delegation: "IS NULL" | "IS NOT NULL") => sql`(
    SELECT count(*)
    FROM ${schema.agentToolsTable}
    INNER JOIN ${schema.toolsTable}
      ON ${qualified(schema.toolsTable.id)} = ${qualified(schema.agentToolsTable.toolId)}
    WHERE ${qualified(schema.agentToolsTable.agentId)} = ${qualified(schema.agentsTable.id)}
      AND ${qualified(schema.toolsTable.delegateToAgentId)} ${sql.raw(delegation)}
  )`;
  switch (sortBy) {
    case "toolsCount":
      return {
        regular: sql`CASE WHEN ${qualified(schema.agentsTable.accessAllTools)}
          THEN ${ALL_SORTS_ABOVE_ANY_COUNT}::bigint
          ELSE ${assigned("IS NULL")} END`,
        external: sql`-1::bigint`,
      };
    case "subagentsCount":
      return {
        regular: sql`CASE WHEN ${qualified(schema.agentsTable.accessAllSubagents)}
          THEN ${ALL_SORTS_ABOVE_ANY_COUNT}::bigint
          ELSE ${assigned("IS NOT NULL")} END`,
        external: sql`-1::bigint`,
      };
    case "lastUsedAt":
      // The later of the two signals, as the row displays it; correlated per
      // agent for the reason given in `findAllPaginated`'s lastUsedAt sort.
      return {
        regular: sql`GREATEST(
          COALESCE((
            SELECT max(${qualified(schema.mcpToolCallsTable.createdAt)})
            FROM ${schema.mcpToolCallsTable}
            WHERE ${qualified(schema.mcpToolCallsTable.agentId)} = ${qualified(schema.agentsTable.id)}
          ), '-infinity'::timestamp),
          COALESCE((
            SELECT max(${qualified(schema.interactionsTable.createdAt)})
            FROM ${schema.interactionsTable}
            WHERE ${qualified(schema.interactionsTable.profileId)} = ${qualified(schema.agentsTable.id)}
          ), '-infinity'::timestamp)
        )`,
        external: sql`'-infinity'::timestamp`,
      };
    default:
      return { regular: sql`0`, external: sql`0` };
  }
}

const ALL_SORTS_ABOVE_ANY_COUNT = 2147483647;

/**
 * A column with its table's name. Selected inside the catalog's UNION, Drizzle
 * renders a bare column name, which a correlated subquery would resolve
 * against its own table: `"agent_id" = "id"` compares two `mcp_tool_calls`
 * columns instead of reaching out to `agents`.
 */
function qualified(column: AnyPgColumn): SQL {
  return sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
}

/** Shared by the startup preflight and the per-member creation guard. */
function personalChatAgentConditions(params: {
  userId: string | AnyPgColumn;
  organizationId: string | AnyPgColumn;
  excludeId?: string;
}) {
  return [
    eq(schema.agentsTable.organizationId, params.organizationId),
    eq(schema.agentsTable.authorId, params.userId),
    eq(schema.agentsTable.agentType, "agent"),
    agentAudienceIs("personal"),
    eq(schema.agentsTable.builtIn, false),
    params.excludeId ? ne(schema.agentsTable.id, params.excludeId) : undefined,
  ];
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/** Match the scope actually returned by selector hydration, including proxy rows. */
function optionScopeCondition(scope: AgentScope): SQL {
  const table = schema.agentsTable;
  return or(
    and(eq(table.agentType, "llm_proxy"), eq(table.scope, scope)),
    and(ne(table.agentType, "llm_proxy"), agentAudienceIs(scope)),
  ) as SQL;
}

/** Same direct read recipients and existing-row filter as findReadRecipientDetails. */
function optionRecipientCondition(
  subject: "team" | "user",
  ids: string[],
): SQL {
  if (ids.length === 0) return sql`true`;
  const recipientTable = subject === "team" ? sql`team` : sql`"user"`;
  const grant =
    subject === "team"
      ? ResourcePermissionPolicyModel.teamReadGrantCondition(
          sql`recipient_entry`,
        )
      : sql`(recipient_entry->'actions') ? 'read' AND recipient_entry->'subject'->>'type' = 'user'`;
  return sql`NOT EXISTS (
    SELECT 1 FROM unnest(${sql.param(ids)}::text[]) desired(id)
    WHERE NOT (${subject === "user" ? sql`coalesce(${schema.agentsTable.authorId} = desired.id, false) OR` : sql``} EXISTS (
      SELECT 1 FROM resource_permission_policies recipient_policy
      CROSS JOIN LATERAL jsonb_array_elements(recipient_policy.grants) recipient_entry
      JOIN ${recipientTable} existing_recipient ON existing_recipient.id = recipient_entry->'subject'->>'id'
      WHERE recipient_policy.scope = ${schema.agentsTable.id}::text
        AND recipient_policy.resource IN ('agent', 'mcpGateway')
        AND ${grant} AND existing_recipient.id = desired.id
    ))
  )`;
}

/** Search the existing picker text in SQL; relation names are grouped set-wise. */
function optionSearchCondition(filters: AgentOptionFilters): SQL {
  const pattern = `%${escapeLikePattern(filters.search ?? "")}%`;
  const table = schema.agentsTable;
  if (filters.searchMode === "name") return ilike(table.name, pattern);
  if (filters.searchMode === "name_or_description")
    return or(
      ilike(table.name, pattern),
      ilike(table.description, pattern),
    ) as SQL;
  const teamGrant =
    ResourcePermissionPolicyModel.teamReadGrantCondition(sql`search_entry`);
  return sql`${table.id} IN (
    SELECT search_agent.id FROM agents search_agent
    LEFT JOIN "user" search_owner ON search_owner.id = search_agent.author_id AND search_agent.created_by_service_account_id IS NULL
    LEFT JOIN service_accounts search_account ON search_account.id = search_agent.created_by_service_account_id
    LEFT JOIN (
      SELECT scope, string_agg(name, ' ' ORDER BY first_position) names
      FROM (
        SELECT search_policy.scope, search_team.id, search_team.name,
          min(search_policy.organization_id || ':' || search_policy.resource || ':' || lpad(search_position::text, 20, '0')) first_position
        FROM resource_permission_policies search_policy
        CROSS JOIN LATERAL jsonb_array_elements(search_policy.grants) WITH ORDINALITY AS entries(search_entry, search_position)
        JOIN team search_team ON search_team.id = search_entry->'subject'->>'id'
        WHERE search_policy.resource IN ('agent', 'mcpGateway') AND ${teamGrant}
        GROUP BY search_policy.scope, search_team.id, search_team.name
      ) search_distinct_teams GROUP BY scope
    ) search_teams ON search_teams.scope = search_agent.id::text
    WHERE concat_ws(' ', search_agent.name,
      nullif(search_owner.email, ''),
      nullif(CASE WHEN search_agent.created_by_service_account_id IS NOT NULL THEN search_account.name ELSE search_owner.name END, ''),
      nullif(search_teams.names, '')) ILIKE ${pattern}
  )`;
}
// SPDX-SnippetEnd

const ChatRosterCursorPositionSchema = z.object({
  rank: z.number().int().min(0).max(3),
  name: z.string(),
});
