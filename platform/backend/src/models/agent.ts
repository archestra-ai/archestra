import {
  type ArchestraToolShortName,
  BUILT_IN_AGENT_IDS,
  DEFAULT_LLM_PROXY_NAME,
  getCreationDefaultArchestraToolShortNames,
  type PaginationQuery,
  PLAYWRIGHT_MCP_CATALOG_ID,
  parseFullToolName,
  providerRequiresPerUserCredential,
  SANDBOX_RUNTIME_ARCHESTRA_TOOL_SHORT_NAMES,
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
  ilike,
  inArray,
  isNotNull,
  isNull,
  max,
  min,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { LRUCacheManager } from "@/cache-manager";
import { clearChatMcpClient } from "@/clients/chat-mcp-client";
import config from "@/config";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import { hardDelete, restore, softDelete } from "@/database/soft-delete";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import logger from "@/logging";
import { registerProcessLocalCache } from "@/process-local-cache-registry";
import { isSkillSandboxAvailableForAgent } from "@/skills/skill-sandbox-availability";
import {
  type Agent,
  type AgentScope,
  type AgentScopeFilter,
  type AgentToolRef,
  type AgentType,
  GATEWAY_CAPABLE_AGENT_TYPES,
  type GatewayAgent,
  type InsertAgent,
  type McpServerAgentUsage,
  type ReadinessAgent,
  type SortingQuery,
  type UpdateAgent,
} from "@/types";
import { isUniqueConstraintError } from "@/utils/db";
import { isUuid } from "@/utils/uuid";
import AgentConnectorAssignmentModel from "./agent-connector-assignment";
import AgentExcludedConnectorModel from "./agent-excluded-connector";
import AgentExcludedSkillModel from "./agent-excluded-skill";
import AgentExcludedSubagentModel from "./agent-excluded-subagent";
import AgentExcludedToolModel from "./agent-excluded-tool";
import AgentKnowledgeBaseModel from "./agent-knowledge-base";
import AgentLabelModel from "./agent-label";
import AgentSkillModel from "./agent-skill";
import AgentSuggestedPromptModel from "./agent-suggested-prompt";
import AgentTeamModel from "./agent-team";
import AgentToolModel from "./agent-tool";
import AgentUserModel from "./agent-user";
import AgentVersionModel from "./agent-version";
import McpToolCallModel from "./mcp-tool-call";
import OrganizationModel from "./organization";
import ToolModel from "./tool";

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
   * Populate author identity on agents by looking up users in one batch.
   */
  private static async populateAuthorNames(agents: Agent[]): Promise<void> {
    const authorIds = [
      ...new Set(
        agents.map((a) => a.authorId).filter((id): id is string => id !== null),
      ),
    ];
    if (authorIds.length === 0) return;

    const users = await db
      .select({
        id: schema.usersTable.id,
        name: schema.usersTable.name,
        email: schema.usersTable.email,
      })
      .from(schema.usersTable)
      .where(inArray(schema.usersTable.id, authorIds));

    const authorMap = new Map(users.map((user) => [user.id, user]));
    for (const agent of agents) {
      const author = agent.authorId ? authorMap.get(agent.authorId) : null;
      agent.authorName = author?.name ?? null;
      agent.authorEmail = author?.email ?? null;
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
   *
   * The `IN` list is one page of agents, so the
   * `(profile_id, created_at DESC)` index answers each agent's max with a
   * backward scan instead of walking a very large table.
   */
  private static async getLastInteractionAtForAgents(
    agentIds: string[],
  ): Promise<Map<string, Date>> {
    if (agentIds.length === 0) return new Map();

    const rows = await db
      .select({
        profileId: schema.interactionsTable.profileId,
        lastInteractionAt: max(schema.interactionsTable.createdAt),
      })
      .from(schema.interactionsTable)
      .where(inArray(schema.interactionsTable.profileId, agentIds))
      .groupBy(schema.interactionsTable.profileId);

    const lastInteractionMap = new Map<string, Date>();
    for (const row of rows) {
      if (row.profileId && row.lastInteractionAt) {
        lastInteractionMap.set(row.profileId, row.lastInteractionAt);
      }
    }
    return lastInteractionMap;
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
    const modelProviderMap = new Map(modelRows.map((r) => [r.id, r.provider]));
    const modelNameMap = new Map(modelRows.map((r) => [r.id, r.modelName]));

    for (const agent of agents) {
      const provider: SupportedProvider | null =
        (agent.llmApiKeyId ? keyProviderMap.get(agent.llmApiKeyId) : null) ??
        (agent.modelId ? modelProviderMap.get(agent.modelId) : null) ??
        null;
      agent.resolvedLlmProvider = provider;
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
      ...agent
    }: InsertAgent & {
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
      /**
       * Skip auto-assigning the creation-default built-in tool set. Used by
       * clone and import, which set their own authoritative assignment set
       * right after create (a verbatim copy of the source agent, or the import
       * payload's tools). Without this, the additive default assignment would
       * force built-ins the source/payload deliberately lacked (e.g. todo_write)
       * onto the new agent.
       */
      skipCreationDefaultTools?: boolean;
      /**
       * Delegation targets the new agent starts with excluded from its
       * Auto-subagent surface (today: the Advisor, which is opt-in). Applied
       * inside create so version 1's snapshot already records them — a
       * follow-up write from the caller would fork a second version, and one
       * made by the client silently never happens for roles without
       * `agent:read`. Which ids these are is the caller's rule; see
       * `agentSubagentExclusionsService.getCreationDefaultExclusions`.
       */
      defaultExcludedSubagentIds?: string[];
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

    const [createdAgent] = await AgentModel.insertWithSlugRetry({
      ...agent,
      ...(enableAccessAllTools && { accessAllTools: false }),
      organizationId,
      ...(slug && { slug }),
      ...(authorId && { authorId }),
    });

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
      await AgentSuggestedPromptModel.syncForAgent(
        createdAgent.id,
        suggestedPrompts,
      );
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

      // Code-execution sandbox + persistent-files tools — gated on the sandbox
      // runtime flag, same as the composer.
      if (composesGroup(SANDBOX_RUNTIME_ARCHESTRA_TOOL_SHORT_NAMES)) {
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

    // Seed the caller's default Auto-mode subagent exclusions. Before the
    // version-1 fork below, so the first snapshot carries them like any other
    // part of the created config. Best-effort, like the fork itself: the agent
    // row and its junctions are already committed (create is not transactional,
    // and this write is a delete+insert of its own), so throwing here would
    // leave a half-made agent behind. One that starts with the Advisor
    // reachable is degraded, not broken.
    if (
      options?.defaultExcludedSubagentIds &&
      options.defaultExcludedSubagentIds.length > 0
    ) {
      try {
        await AgentExcludedSubagentModel.replaceForAgent(
          createdAgent.id,
          options.defaultExcludedSubagentIds,
        );
      } catch (error) {
        logger.warn(
          { error, agentId: createdAgent.id },
          "Default subagent exclusions were not seeded; agent created without them",
        );
      }
    }

    // Fork version 1 now that the full config of this create (row, junctions,
    // auto-assigned tools, exclusion pre-fill) is in place. Best-effort: a
    // versioning failure must never fail the create itself.
    const fork = await AgentVersionModel.forkIfChangedBestEffort(
      createdAgent.id,
    );
    if (fork) {
      createdAgent.latestVersion = fork.version;
    }

    // Get team details and tools for the created agent
    const [teamDetails, assignedTools] = await Promise.all([
      teams && teams.length > 0
        ? AgentTeamModel.getTeamDetailsForAgent(createdAgent.id)
        : Promise.resolve([]),
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
    AgentModel.filterUnavailableKnowledgeTools([result]);

    return result;
  }

  /**
   * Find all agents with optional filtering by agentType or agentTypes
   */
  static async findAll(
    userId?: string,
    isAgentAdmin?: boolean,
    options?: {
      agentType?: AgentType;
      agentTypes?: AgentType[];
      excludeBuiltIn?: boolean;
      /**
       * Keep the advisor in the results even while built-ins are excluded.
       * It is the one built-in another agent is meant to reach, so the
       * subagent picker needs it without also offering the platform
       * machinery — dual-LLM, compaction, title generation.
       */
      includeAdvisor?: boolean;
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
    },
  ): Promise<Agent[]> {
    // Tools are attached afterwards as slim refs via one batched query:
    // joining them here multiplied every agent row (system prompt included)
    // by that agent's tool count.
    let query = db.select().from(schema.agentsTable).$dynamic();

    // Build where conditions
    const whereConditions: SQL[] = [
      getAgentStatusCondition(options?.status ?? "active"),
    ];

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

    // Exclude built-in agents when explicitly requested or when user is not an admin
    if (options?.excludeBuiltIn || !isAgentAdmin) {
      whereConditions.push(
        options?.includeAdvisor
          ? (or(
              eq(schema.agentsTable.builtIn, false),
              eq(
                sql`${schema.agentsTable.builtInAgentConfig}->>'name'`,
                BUILT_IN_AGENT_IDS.ADVISOR,
              ),
            ) as SQL)
          : eq(schema.agentsTable.builtIn, false),
      );
    }

    // Filter by scope if specified
    if (options?.scope) {
      whereConditions.push(eq(schema.agentsTable.scope, options.scope));
    }

    // Exclude other users' personal agents (show non-personal + own personal)
    if (options?.excludeOtherPersonalAgents && userId) {
      const condition = or(
        ne(schema.agentsTable.scope, "personal"),
        eq(schema.agentsTable.authorId, userId),
      );
      if (condition) {
        whereConditions.push(condition);
      }
    }

    // Apply access control filtering for non-agent admins
    if (userId && !isAgentAdmin) {
      const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        userId,
        false,
      );

      if (accessibleAgentIds.length === 0) {
        return [];
      }

      whereConditions.push(inArray(schema.agentsTable.id, accessibleAgentIds));
    }

    // Apply all where conditions if any exist
    if (whereConditions.length > 0) {
      query = query.where(and(...whereConditions));
    }

    const rows = await query;

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
    // avoid N+1
    const [toolRows, teamsMap, usersMap, labelsMap] = await Promise.all([
      agentIds.length > 0 && options?.includeTools !== false
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
            .where(inArray(schema.agentToolsTable.agentId, agentIds))
        : Promise.resolve([]),
      AgentTeamModel.getTeamDetailsForAgents(agentIds),
      AgentUserModel.getUserDetailsForAgents(agentIds),
      AgentLabelModel.getLabelsForAgents(agentIds),
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
      AgentModel.populateAuthorNames(agents),
      AgentModel.populateKnowledgeBaseIds(agents),
      AgentModel.populateConnectorIds(agents),
      AgentModel.populateSuggestedPrompts(agents),
      AgentModel.populateResolvedLlm(agents),
    ]);
    AgentModel.filterUnavailableKnowledgeTools(agents);

    return agents;
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
        .where(inArray(schema.agentToolsTable.agentId, agentIds)),
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
    await AgentModel.populateResolvedLlm(results);
    AgentModel.filterUnavailableKnowledgeTools(results);

    return results;
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
        .where(inArray(schema.agentToolsTable.agentId, agentIds)),
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
   * Built-in agents are left out: title generation, context compaction and the
   * dual-LLM pair are machinery this platform runs on, not collaborators
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
   * Find all non-personal internal agents (excluding built-in agents).
   * Used to populate the agent selection dropdown in Teams/Slack/etc channels.
   * Personal agents are excluded because channels are shared — only org/team
   * scoped agents make sense for channel assignment.
   */
  static async findAllInternalAgents(): Promise<
    Pick<Agent, "id" | "name" | "scope" | "authorId">[]
  > {
    const agents = await db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        scope: schema.agentsTable.scope,
        authorId: schema.agentsTable.authorId,
      })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.agentType, "agent"),
          eq(schema.agentsTable.builtIn, false),
          ne(schema.agentsTable.scope, "personal"),
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
      })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.agentType, "agent"),
          eq(schema.agentsTable.builtIn, false),
          or(
            ne(schema.agentsTable.scope, "personal"),
            and(
              eq(schema.agentsTable.scope, "personal"),
              eq(schema.agentsTable.authorId, userId),
            ),
          ),
          notDeleted(schema.agentsTable),
        ),
      )
      .orderBy(asc(schema.agentsTable.name));

    return agents;
  }

  /**
   * Find all agents with pagination, sorting, and filtering support
   */
  static async findAllPaginated(
    pagination: PaginationQuery,
    sorting?: SortingQuery,
    filters?: {
      name?: string;
      agentType?: AgentType;
      agentTypes?: AgentType[];
      scope?: AgentScopeFilter;
      teamIds?: string[];
      authorIds?: string[];
      excludeAuthorIds?: string[];
      excludeOtherPersonalAgents?: boolean;
      labels?: Record<string, string[]>;
      status?: AgentRecordStatus;
    },
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<PaginatedResult<Agent>> {
    // Determine the ORDER BY clause based on sorting params
    const orderByClause = AgentModel.getOrderByClause(sorting);
    const personalAgentPriorityOrderClauses =
      AgentModel.getPersonalAgentPriorityOrderClauses(userId);

    // Build where clause for filters and access control
    const whereConditions: SQL[] = [
      getAgentStatusCondition(filters?.status ?? "active"),
    ];

    // Add name filter if provided
    if (filters?.name) {
      whereConditions.push(ilike(schema.agentsTable.name, `%${filters.name}%`));
    }

    // Add agentTypes filter if provided (array of types)
    if (filters?.agentTypes && filters.agentTypes.length > 0) {
      whereConditions.push(
        inArray(schema.agentsTable.agentType, filters.agentTypes),
      );
    }
    // Add agentType filter if provided (single type, backwards compatible)
    else if (filters?.agentType !== undefined) {
      whereConditions.push(eq(schema.agentsTable.agentType, filters.agentType));
    }

    // Add scope filter if provided
    if (filters?.scope === "built_in") {
      whereConditions.push(eq(schema.agentsTable.builtIn, true));
    } else if (filters?.scope === "personal") {
      whereConditions.push(eq(schema.agentsTable.scope, "personal"));
      whereConditions.push(eq(schema.agentsTable.builtIn, false));
    } else if (filters?.scope === "team") {
      whereConditions.push(eq(schema.agentsTable.scope, "team"));
      whereConditions.push(eq(schema.agentsTable.builtIn, false));
    } else if (filters?.scope === "org") {
      whereConditions.push(eq(schema.agentsTable.scope, "org"));
      whereConditions.push(eq(schema.agentsTable.builtIn, false));
    } else {
      // No scope filter: exclude built-in agents by default.
      // Built-in agents are only shown when explicitly filtered via scope=built_in.
      whereConditions.push(eq(schema.agentsTable.builtIn, false));
    }

    // Hide built-in agents from non-admin users
    if (!isAgentAdmin) {
      whereConditions.push(eq(schema.agentsTable.builtIn, false));
    }

    // Add teamIds filter if provided (filter team-scoped agents by specific teams)
    if (filters?.teamIds && filters.teamIds.length > 0) {
      const agentIdsInTeams = await db
        .selectDistinct({ agentId: schema.agentTeamsTable.agentId })
        .from(schema.agentTeamsTable)
        .where(inArray(schema.agentTeamsTable.teamId, filters.teamIds));

      const ids = agentIdsInTeams.map((r) => r.agentId);
      if (ids.length === 0) {
        return createPaginatedResult([], 0, pagination);
      }
      whereConditions.push(inArray(schema.agentsTable.id, ids));
    }

    // Add authorIds filter if provided (filter personal agents by owner)
    if (filters?.authorIds && filters.authorIds.length > 0) {
      whereConditions.push(
        inArray(schema.agentsTable.authorId, filters.authorIds),
      );
    }

    // Exclude specific authors if provided
    if (filters?.excludeAuthorIds && filters.excludeAuthorIds.length > 0) {
      const condition = or(
        isNull(schema.agentsTable.authorId),
        notInArray(schema.agentsTable.authorId, filters.excludeAuthorIds),
      );
      if (condition) {
        whereConditions.push(condition);
      }
    }

    // Exclude other users' personal agents (show non-personal + own personal)
    if (filters?.excludeOtherPersonalAgents && userId) {
      const condition = or(
        ne(schema.agentsTable.scope, "personal"),
        eq(schema.agentsTable.authorId, userId),
      );
      if (condition) {
        whereConditions.push(condition);
      }
    }

    // Add label filters if provided (AND across keys, OR within values)
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

        const ids = agentIdsWithLabel.map((r) => r.agentId);
        if (ids.length === 0) {
          return createPaginatedResult([], 0, pagination);
        }
        whereConditions.push(inArray(schema.agentsTable.id, ids));
      }
    }

    // Access-control filtering. Non-admins are always restricted to the agents
    // they can access (own personal + org + teams they belong to). An admin is
    // restricted the same way ONLY in the default active "All" view (no explicit
    // scope), so it shows just what they can access rather than the whole org —
    // oversight (other users' personal agents and team agents for teams they
    // aren't in) is dropped there. Explicit scopes keep the admin's full
    // org-wide base (oversight stays reachable via Team → pick that team and
    // Personal → Other users), and so does the admin-only deleted view, whose
    // whole purpose is reviewing every removed agent.
    const isDefaultActiveAllView =
      filters?.scope === undefined &&
      (filters?.status ?? "active") !== "deleted";
    const restrictToAccessible = !isAgentAdmin || isDefaultActiveAllView;
    if (userId && restrictToAccessible) {
      const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        userId,
        false,
      );

      if (accessibleAgentIds.length === 0) {
        return createPaginatedResult([], 0, pagination);
      }

      whereConditions.push(inArray(schema.agentsTable.id, accessibleAgentIds));
    }

    const whereClause =
      whereConditions.length > 0 ? and(...whereConditions) : undefined;

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
      const teamNameSubquery = db
        .select({
          agentId: schema.agentTeamsTable.agentId,
          teamName: min(schema.teamsTable.name).as("teamName"),
        })
        .from(schema.agentTeamsTable)
        .leftJoin(
          schema.teamsTable,
          eq(schema.agentTeamsTable.teamId, schema.teamsTable.id),
        )
        .groupBy(schema.agentTeamsTable.agentId)
        .as("teamNames");

      query = query
        .leftJoin(
          teamNameSubquery,
          eq(schema.agentsTable.id, teamNameSubquery.agentId),
        )
        .orderBy(
          ...personalAgentPriorityOrderClauses,
          direction(sql`COALESCE(${teamNameSubquery.teamName}, '')`),
        );
    } else {
      query = query.orderBy(
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

    // Step 2: Get full agent data with tools for the paginated agent IDs
    const [agentsData, [{ total: totalResult }]] = await Promise.all([
      db
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
        .where(inArray(schema.agentsTable.id, sortedAgentIds)),
      db.select({ total: count() }).from(schema.agentsTable).where(whereClause),
    ]);

    // Sort in memory to maintain the order from the sorted query
    const orderMap = new Map(sortedAgentIds.map((id, index) => [id, index]));
    agentsData.sort(
      (a, b) =>
        (orderMap.get(a.agents.id) ?? 0) - (orderMap.get(b.agents.id) ?? 0),
    );

    // Group the flat join results by agent
    const agentsMap = new Map<string, Agent>();

    for (const row of agentsData) {
      const agent = row.agents;
      const tool = row.tools;

      if (!agentsMap.has(agent.id)) {
        agentsMap.set(agent.id, {
          ...agent,
          tools: [],
          teams: [] as Array<{ id: string; name: string }>,
          users: [] as Array<{ id: string; name: string; email: string }>,
          labels: [],
          knowledgeBaseIds: [],
          connectorIds: [],
          suggestedPrompts: [],
        });
      }

      // Add tool if it exists (leftJoin returns null for agents with no tools)
      if (tool) {
        agentsMap.get(agent.id)?.tools.push(tool);
      }
    }

    const agents = Array.from(agentsMap.values());
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
      AgentModel.populateAuthorNames(agents),
      AgentModel.populateKnowledgeBaseIds(agents),
      AgentModel.populateConnectorIds(agents),
      AgentModel.populateSuggestedPrompts(agents),
      AgentModel.populateResolvedLlm(agents),
      AgentModel.populateLastUsedAt(agents),
    ]);
    AgentModel.filterUnavailableKnowledgeTools(agents);

    return createPaginatedResult(agents, Number(totalResult), pagination);
  }

  /**
   * Helper to get the appropriate ORDER BY clause based on sorting params
   */
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
          WHEN ${schema.agentsTable.scope} = 'personal'
            AND ${schema.agentsTable.authorId} = ${userId}
          THEN 0
          ELSE 1
        END
      `),
    ];
  }

  private static filterUnavailableKnowledgeTools(agents: Agent[]): void {
    for (const agent of agents) {
      const hasKnowledgeSources =
        agent.knowledgeBaseIds.length > 0 || agent.connectorIds.length > 0;

      if (hasKnowledgeSources) {
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
   * Names of every live agent that can serve as an MCP gateway in this
   * organization. External clients register gateways under a server name
   * derived from these (see `toMcpClientServerName`), so the LLM proxy uses
   * them to recognize client-decorated gateway tool names.
   */
  static async findGatewayNamesByOrganizationId(
    organizationId: string,
  ): Promise<string[]> {
    const agents = await db
      .select({ name: schema.agentsTable.name })
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

    return agents.map((agent) => agent.name);
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

  /**
   * Agents a toolset backfill may assign to. Everything in the organization
   * except the advisor, which answers questions and must not act: a tool it
   * holds is one a consultation can call, and the advisor's whole contract is
   * that it returns a recommendation and edits nothing.
   */
  static async findToolAssignableIdsByOrganizationId(
    organizationId: string,
  ): Promise<string[]> {
    const agents = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.organizationId, organizationId),
          ne(
            sql`coalesce(${schema.agentsTable.builtInAgentConfig}->>'name', '')`,
            BUILT_IN_AGENT_IDS.ADVISOR,
          ),
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

  static async findAccessibleIdsForUser(userId: string): Promise<string[]> {
    const rows = await db
      .selectDistinct({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .leftJoin(
        schema.agentTeamsTable,
        eq(schema.agentsTable.id, schema.agentTeamsTable.agentId),
      )
      .leftJoin(
        schema.teamMembersTable,
        and(
          eq(schema.agentTeamsTable.teamId, schema.teamMembersTable.teamId),
          eq(schema.teamMembersTable.userId, userId),
        ),
      )
      .leftJoin(
        schema.agentUsersTable,
        and(
          eq(schema.agentsTable.id, schema.agentUsersTable.agentId),
          eq(schema.agentUsersTable.userId, userId),
        ),
      )
      .where(
        and(
          notDeleted(schema.agentsTable),
          or(
            eq(schema.agentsTable.scope, "org"),
            // A personal agent reaches its author, and anyone it has been
            // shared with individually. The grant sits beside the scope rather
            // than replacing it, so no scope enum has to learn a new value.
            and(
              eq(schema.agentsTable.scope, "personal"),
              or(
                eq(schema.agentsTable.authorId, userId),
                eq(schema.agentUsersTable.userId, userId),
              ),
            ),
            and(
              eq(schema.agentsTable.scope, "team"),
              eq(schema.teamMembersTable.userId, userId),
            ),
          ),
        ),
      );

    return rows.map((row) => row.id);
  }

  /**
   * Internal agents eligible as Auto-mode delegation targets for a caller:
   * agentType "agent", not soft-deleted, that the caller user can access (org,
   * own personal, or a team the user belongs to), minus the caller agent
   * itself. This is the delegation analog of
   * {@link ToolModel.getMcpToolsAccessibleToUser} — the dynamic surface for
   * `agents.access_all_subagents`. Admins see every internal agent.
   *
   * Built-in agents are excluded with one exception: the advisor exists to be
   * consulted, so it is the only built-in offered as a delegation target. The
   * rest back platform machinery — dual-LLM, compaction, title generation —
   * and delegating to them means driving an internal mechanism by hand.
   */
  static async findAccessibleDelegationTargets(params: {
    userId: string;
    isAdmin: boolean;
    organizationId: string;
    excludeAgentId: string;
    /**
     * The calling agent's environment: delegation never crosses environment
     * boundaries (null is the Default environment), mirroring tool isolation.
     * The advisor is the one exception — its org-wide (env-less) row is
     * reachable from every environment.
     */
    environmentId: string | null;
  }): Promise<
    Pick<Agent, "id" | "name" | "description" | "builtInAgentConfig">[]
  > {
    const { userId, isAdmin, organizationId, excludeAgentId, environmentId } =
      params;

    // The env-less advisor is reachable from every environment; scoping to the
    // caller's organization keeps that exception from surfacing another org's
    // advisor (the admin branch below has no other org fence).
    const advisorException = and(
      isNull(schema.agentsTable.environmentId),
      eq(
        sql`${schema.agentsTable.builtInAgentConfig}->>'name'`,
        BUILT_IN_AGENT_IDS.ADVISOR,
      ),
    );

    const baseConditions = [
      eq(schema.agentsTable.organizationId, organizationId),
      eq(schema.agentsTable.agentType, "agent"),
      or(
        eq(schema.agentsTable.builtIn, false),
        eq(
          sql`${schema.agentsTable.builtInAgentConfig}->>'name'`,
          BUILT_IN_AGENT_IDS.ADVISOR,
        ),
      ),
      ne(schema.agentsTable.id, excludeAgentId),
      or(
        environmentId === null
          ? isNull(schema.agentsTable.environmentId)
          : eq(schema.agentsTable.environmentId, environmentId),
        advisorException,
      ),
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

    return db
      .selectDistinct({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        description: schema.agentsTable.description,
        builtInAgentConfig: schema.agentsTable.builtInAgentConfig,
      })
      .from(schema.agentsTable)
      .leftJoin(
        schema.agentTeamsTable,
        eq(schema.agentsTable.id, schema.agentTeamsTable.agentId),
      )
      .leftJoin(
        schema.teamMembersTable,
        and(
          eq(schema.agentTeamsTable.teamId, schema.teamMembersTable.teamId),
          eq(schema.teamMembersTable.userId, userId),
        ),
      )
      .where(
        and(
          ...baseConditions,
          or(
            eq(schema.agentsTable.scope, "org"),
            and(
              eq(schema.agentsTable.scope, "personal"),
              eq(schema.agentsTable.authorId, userId),
            ),
            and(
              eq(schema.agentsTable.scope, "team"),
              eq(schema.teamMembersTable.userId, userId),
            ),
          ),
        ),
      )
      .orderBy(asc(schema.agentsTable.name));
  }

  static async findDelegationTarget(
    id: string,
  ): Promise<Pick<Agent, "id" | "name"> | null> {
    const [targetAgent] = await db
      .select({ id: schema.agentsTable.id, name: schema.agentsTable.name })
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
   * cannot supply one: `requireScopedModifyPermission` returns early for an
   * admin, and that admin flag is the caller's role in the caller's OWN org, so
   * nothing ever compares the target's tenant. Callers that accept agent ids
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

    const [agents, teamsMap] = await Promise.all([
      db
        .select({
          id: schema.agentsTable.id,
          agentType: schema.agentsTable.agentType,
          scope: schema.agentsTable.scope,
          authorId: schema.agentsTable.authorId,
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
        ),
      AgentTeamModel.getTeamDetailsForAgents(ids),
    ]);

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
      const teams = teamsMap.get(agent.id) ?? [];
      result.set(agent.id, {
        agentType: agent.agentType,
        scope: agent.scope,
        authorId: agent.authorId,
        teamIds: teams.map((t) => t.id),
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

  static async findById(
    id: string,
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<Agent | null> {
    // Check access control for non-agent admins
    if (userId && !isAgentAdmin) {
      const hasAccess = await AgentTeamModel.userHasAgentAccess(
        userId,
        id,
        false,
      );
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
      .values({
        organizationId,
        name: DEFAULT_LLM_PROXY_NAME,
        agentType: "llm_proxy",
        isDefault: true,
        scope: "org",
      })
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
      const hasAccess = await AgentTeamModel.userHasAgentAccess(
        userId,
        id,
        false,
      );
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
    }: Partial<UpdateAgent>,
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
      await AgentSuggestedPromptModel.syncForAgent(id, suggestedPrompts);
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

    return {
      ...updatedAgent,
      tools: toolRows,
      teams: currentTeams,
      labels: currentLabels,
      knowledgeBaseIds: currentKbIds,
      connectorIds: currentConnectorIds,
      suggestedPrompts: currentSuggestedPrompts.get(id) ?? [],
    };
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
    const count = await hardDelete(
      tx ?? db,
      schema.agentsTable,
      eq(schema.agentsTable.id, id),
    );
    return count > 0;
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

    logger.info(
      { userId, organizationId, agentId: agent.id },
      "Created personal chat agent",
    );

    return agent.id;
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
          eq(schema.agentsTable.organizationId, params.organizationId),
          eq(schema.agentsTable.authorId, params.userId),
          eq(schema.agentsTable.agentType, "agent"),
          eq(schema.agentsTable.scope, "personal"),
          eq(schema.agentsTable.builtIn, false),
          params.excludeId
            ? ne(schema.agentsTable.id, params.excludeId)
            : undefined,
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
      .where(
        and(
          eq(schema.agentsTable.organizationId, params.organizationId),
          eq(schema.agentsTable.authorId, params.userId),
          eq(schema.agentsTable.agentType, "agent"),
          eq(schema.agentsTable.scope, "personal"),
          eq(schema.agentsTable.builtIn, false),
        ),
      )
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

      logger.info(
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
          considerContextUntrusted: sourceAgent.considerContextUntrusted,
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
        { skipCreationDefaultTools: true },
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
  ) {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await db.insert(schema.agentsTable).values(values).returning();
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

    return {
      id: row.id,
      name: row.name,
      organizationId: row.organizationId,
      agentType: row.agentType,
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
      considerContextUntrusted: row.considerContextUntrusted,
      toolExposureMode: row.toolExposureMode,
      accessAllTools: row.accessAllTools,
      accessAllSubagents: row.accessAllSubagents,
      accessAllSkills: row.accessAllSkills,
      // passthrough_headers is a text[] of header NAMES (no values), so it is
      // safe to capture verbatim.
      passthroughHeaders: [...(row.passthroughHeaders ?? [])].sort(),
      identityProviderId: row.identityProviderId ?? null,
      environmentId: row.environmentId ?? null,
      incomingEmailEnabled: row.incomingEmailEnabled,
      incomingEmailSecurityMode: row.incomingEmailSecurityMode,
      incomingEmailAllowedDomain: row.incomingEmailAllowedDomain ?? null,
      builtInAgentConfig: row.builtInAgentConfig ?? null,
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
  }
}

const PERSONAL_MCP_GATEWAY_NAME = "My Gateway";
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
