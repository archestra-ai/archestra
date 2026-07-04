import {
  ARCHESTRA_MCP_CATALOG_ID,
  ARCHESTRA_TOOL_SHORT_NAMES,
  type ArchestraToolShortName,
  getArchestraToolFullName,
  isSandboxArchestraToolShortName,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import { userHasPermission } from "@/auth/utils";
import config from "@/config";
import { knowledgeSourceAccessControlService } from "@/knowledge-base/source-access-control";
import { AgentModel, KnowledgeBaseConnectorModel, ToolModel } from "@/models";
import {
  type AgentToolExclusionSets,
  agentToolExclusionsService,
  isToolIdentityExcluded,
  isToolRowExcluded,
} from "@/services/agent-tool-exclusions";
import type { Tool } from "@/types";
import { archestraMcpBranding } from "./branding";
import { filterToolNamesByPermission } from "./rbac";

// Dynamic tool access: when an agent's "access all tools" setting is on, the
// dispatch surface (search_tools / run_tool) is relaxed from "tools assigned to
// the agent" to "tools the user can access" — discovery spans every MCP catalog
// the user can access plus the Archestra built-ins (see
// isExcludedFromDiscovery for the carve-outs), and run_tool executes such a
// tool directly without assigning it. Which credential the
// call uses is decided by the MCP server's connection policy (on-behalf-of the
// caller, or a pinned service account) — same as for an assigned tool; this
// surface only widens access. Nothing is written to the agent: access is
// per-call, so no agent-modify permission is involved. Tool RBAC, invocation
// policies, and per-conversation tool selections still gate every call. The
// per-agent "access all tools" setting is the sole gate.

/**
 * Resolve a run_tool target name to its canonical form (Archestra short names
 * like `run_command` → `archestra__run_command`; everything else unchanged),
 * mirroring run_tool's own resolution so dispatch and access checks line up.
 */
export function resolveRunToolTargetName(requestedName: string): string {
  const isArchestraPrefixed = archestraMcpBranding.isToolName(requestedName);
  if (!isArchestraPrefixed && ARCHESTRA_SHORT_NAME_SET.has(requestedName)) {
    return getArchestraToolFullName(requestedName as ArchestraToolShortName);
  }
  return requestedName;
}

/**
 * Resolve an unassigned third-party tool name to the catalog tool row the user
 * can access, for direct dynamic execution by run_tool. Applies the same gates
 * as discovery (agent setting, org setting, real user, catalog visibility,
 * per-tool RBAC) and resolves duplicate names with the same deterministic
 * ordering search_tools uses, so run_tool executes the row search described.
 * Returns null when the strict assigned-tools-only behavior applies or the
 * tool is not accessible.
 */
export async function resolveDynamicTool(params: {
  toolName: string;
  agentId: string;
  userId?: string;
  organizationId?: string;
  /** Pre-loaded per-agent exclusion sets, so a handler that already fetched
   * them (run_tool dispatch) does not re-query. Loaded here when omitted. */
  exclusionSets?: AgentToolExclusionSets;
}): Promise<Tool | null> {
  const { toolName } = params;
  // Archestra built-ins are dispatched on the "archestra" route and gated by
  // isDynamicallyAvailableArchestraTool; a third-party catalog row reusing a
  // reserved archestra-prefixed name must not be executable through this path.
  if (
    archestraMcpBranding.isToolName(toolName) ||
    isExcludedFromDiscovery(toolName)
  ) {
    return null;
  }
  const ctx = await dynamicAccessContext(params);
  if (!ctx) {
    return null;
  }

  // Per-agent exclusions (Auto-tool mode): an excluded row must not resolve.
  // Filtering the candidate list (not just the winner) keeps this consistent
  // with search, which still shows a same-named row from a non-excluded catalog.
  const exclusionSets =
    params.exclusionSets ??
    (await agentToolExclusionsService.getExclusionSets(params.agentId));

  // Resolve the name within the user-accessible tool set (tool names are only
  // unique per catalog, so a global name lookup could land on a row in a
  // catalog the user cannot access).
  const accessible = (
    await getAccessibleTools(
      ctx.userId,
      ctx.organizationId,
      ctx.agentEnvironmentId,
      toolName,
    )
  ).filter((candidate) => !isToolRowExcluded(candidate, exclusionSets));
  const tool = accessible[0];
  if (!tool) {
    return null;
  }

  // Per-tool RBAC, mirroring the search surface (search-tools.ts filters the
  // same way), so a tool the user cannot see in search cannot be run either.
  const permitted = await filterToolNamesByPermission(
    [tool.name],
    ctx.userId,
    ctx.organizationId,
  );
  return permitted.has(tool.name) ? tool : null;
}

/**
 * Resolve the tool that backs an MCP App `ui://` resource when the tool is
 * reachable only through dynamic access ("all tools" mode) and has no
 * `agent_tools` assignment — so a resource read can find its catalog/server
 * without an assignment. Applies the same gates as `resolveDynamicTool` (agent
 * setting, catalog visibility, per-tool RBAC). Returns null when the strict
 * assigned-only behavior applies or the resource is not accessible.
 */
export async function resolveDynamicToolByUiResource(params: {
  resourceUri: string;
  agentId: string;
  userId?: string;
  organizationId?: string;
}): Promise<Tool | null> {
  const ctx = await dynamicAccessContext(params);
  if (!ctx) {
    return null;
  }

  // Per-agent exclusions (Auto-tool mode): an excluded backing tool must not
  // make its resource reachable, and an excluded catalog must not count toward
  // the multi-catalog ambiguity check below.
  const exclusionSets = await agentToolExclusionsService.getExclusionSets(
    params.agentId,
  );

  const accessible = (
    await ToolModel.getMcpToolsAccessibleToUser({
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      environmentId: ctx.agentEnvironmentId,
      isAdmin: await userIsCatalogAdmin(ctx.userId, ctx.organizationId),
      uiResourceUri: params.resourceUri,
    })
  ).filter((candidate) => !isToolRowExcluded(candidate, exclusionSets));
  // A ui:// URI is not globally unique. If it matches tools across more than one
  // catalog the user can reach, a colliding catalog could serve app HTML in
  // place of the tool that actually ran — and a resource read carries only the
  // URI, so it cannot disambiguate. Fail closed rather than guess.
  const matchedCatalogIds = new Set(accessible.map((t) => t.catalogId));
  if (matchedCatalogIds.size > 1) {
    return null;
  }
  const tool = accessible[0];
  if (!tool) {
    return null;
  }

  const permitted = await filterToolNamesByPermission(
    [tool.name],
    ctx.userId,
    ctx.organizationId,
  );
  return permitted.has(tool.name) ? tool : null;
}

/**
 * Whether an unassigned Archestra built-in may execute for this agent/user
 * anyway. Under dynamic tool access every built-in is runnable without an
 * assignment, subject to:
 * - the dynamic-access gates (agent's "access all tools" setting + a real
 *   authenticated user, see dynamicAccessContext);
 * - per-agent exclusions (Auto-tool mode);
 * - the deployment feature gates that also govern registration/execution in
 *   index.ts — sandbox runtime, Projects, and apps (see
 *   isBuiltInFeatureEnabled);
 * - query_knowledge_sources additionally requires the user to have access to
 *   at least one knowledge connector.
 * The caller (executeArchestraTool) has already enforced the tool's RBAC
 * permission; this adds the dynamic-access gates on top.
 */
export async function isDynamicallyAvailableArchestraTool(params: {
  toolName: string;
  agentId: string;
  userId?: string;
  organizationId?: string;
  /** Pre-loaded per-agent exclusion sets, so a handler that already fetched
   * them (executeArchestraTool's assignment gate) does not re-query. */
  exclusionSets?: AgentToolExclusionSets;
}): Promise<boolean> {
  const shortName = archestraMcpBranding.getToolShortName(params.toolName);
  if (shortName == null) {
    return false;
  }
  if (!isBuiltInFeatureEnabled(shortName)) {
    return false;
  }
  const ctx = await dynamicAccessContext(params);
  if (!ctx) {
    return false;
  }
  // Per-agent exclusions (Auto-tool mode): an excluded built-in loses the
  // dynamic relaxation. Built-ins are matched by dispatch identity (the row
  // in the Archestra catalog with this name).
  const exclusionSets =
    params.exclusionSets ??
    (await agentToolExclusionsService.getExclusionSets(params.agentId));
  if (
    isToolIdentityExcluded(
      { catalogId: ARCHESTRA_MCP_CATALOG_ID, name: params.toolName },
      exclusionSets,
    )
  ) {
    return false;
  }
  return shortName === TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME
    ? userHasAccessibleKnowledgeConnectors(
        ctx.userId,
        ctx.organizationId,
        ctx.agentEnvironmentId,
      )
    : true;
}

/**
 * Tools the user can access that are not yet assigned to the agent — the widened
 * portion of the search_tools search space. Third-party MCP tools from every
 * catalog the user can access plus the Archestra built-ins, minus the
 * exclusions in `isExcludedFromDiscovery`: `agent__` rows, the meta tools
 * (search_tools/run_tool), feature-gated-off built-in groups, and
 * query_knowledge_sources when the user cannot access a knowledge connector.
 */
export async function getUnassignedDiscoverableTools(params: {
  assignedToolNames: Set<string>;
  agentId: string;
  userId?: string;
  organizationId?: string;
  /** Pre-loaded per-agent exclusion sets, so a handler that already fetched
   * them (search_tools, run_tool recovery) does not re-query. */
  exclusionSets?: AgentToolExclusionSets;
}): Promise<Tool[]> {
  const { assignedToolNames } = params;
  const ctx = await dynamicAccessContext(params);
  if (!ctx) {
    return [];
  }

  // Per-agent exclusions (Auto-tool mode): excluded catalogs/tools leave the
  // discovery space entirely.
  const exclusionSets =
    params.exclusionSets ??
    (await agentToolExclusionsService.getExclusionSets(params.agentId));

  const [accessibleTools, hasKnowledgeConnectors] = await Promise.all([
    getAccessibleTools(ctx.userId, ctx.organizationId, ctx.agentEnvironmentId),
    userHasAccessibleKnowledgeConnectors(
      ctx.userId,
      ctx.organizationId,
      ctx.agentEnvironmentId,
    ),
  ]);
  return accessibleTools.filter(
    (tool) =>
      !assignedToolNames.has(tool.name) &&
      !isExcludedFromDiscovery(tool.name, { hasKnowledgeConnectors }) &&
      !isToolRowExcluded(tool, exclusionSets),
  );
}

/**
 * Shared gate for the dynamic-access surfaces (search widening, run_tool
 * dynamic dispatch, the built-in relaxations, and the user-scoped
 * query_knowledge_sources fallback) so they cannot drift apart. Dynamic access
 * needs all of:
 * - the agent's "access all tools" setting on (per-agent opt-in),
 * - a real authenticated user (org/team-token sessions and the internal
 *   "system" user keep the strict assigned-tools-only behavior).
 * Returns the validated user/org pair, or null when the strict behavior
 * applies.
 */
export async function dynamicAccessContext(params: {
  agentId: string;
  userId?: string;
  organizationId?: string;
}): Promise<{
  userId: string;
  organizationId: string;
  agentEnvironmentId: string | null;
} | null> {
  const { agentId, organizationId, userId } = params;
  if (!userId || !organizationId || userId === "system") {
    return null;
  }
  const [accessAllTools, agentEnvironmentId] = await Promise.all([
    AgentModel.getAccessAllTools(agentId),
    AgentModel.findEnvironmentId(agentId),
  ]);
  if (!accessAllTools) {
    return null;
  }
  return { userId, organizationId, agentEnvironmentId };
}

// === Internal helpers ===

const ARCHESTRA_SHORT_NAME_SET = new Set<string>(ARCHESTRA_TOOL_SHORT_NAMES);

// Whether at least one knowledge connector is visible to the user (org-wide
// visibility or scoped to one of their teams; knowledgeSource admins see all).
// Gates the dynamic availability of query_knowledge_sources.
async function userHasAccessibleKnowledgeConnectors(
  userId: string,
  organizationId: string,
  environmentId: string | null,
): Promise<boolean> {
  const access =
    await knowledgeSourceAccessControlService.buildAccessControlContext({
      userId,
      organizationId,
    });
  const connectors = await KnowledgeBaseConnectorModel.findByOrganization({
    organizationId,
    canReadAll: access.canReadAll,
    viewerTeamIds: access.teamIds,
    environmentId,
    limit: 1,
  });
  return connectors.length > 0;
}

// Whether a sandbox-group tool is enabled for discovery/dynamic dispatch under
// the current deployment config. Both the runtime tools
// (run_command/upload_file/download_file) and the persistent-files tools
// (search_files/read_file/…) follow the skills-sandbox runtime flag. Non-sandbox
// tools are never enabled by this predicate.
function isSandboxToolEnabled(shortName: string): boolean {
  return (
    config.skillsSandbox.enabled && isSandboxArchestraToolShortName(shortName)
  );
}

// What stays OUT of the unassigned-discovery surface (every other tool —
// third-party or Archestra built-in — is discoverable):
// - `agent__`-named rows (proxy-discovered delegation artifacts) are hidden
//   from search, so they must not be dynamically discoverable/runnable either;
// - the meta tools (search_tools/run_tool) are the dispatch surface itself:
//   always exposed in tools/list and kept out of search results even when
//   assigned (see isExcludedFromSearchResults in search-tools.ts), so an
//   unassigned catalog row for them must not enter this surface;
// - built-ins of a feature-gated-off group — sandbox runtime, Projects, apps —
//   drop out under the same gates as registration/execution (see
//   isBuiltInFeatureEnabled);
// - query_knowledge_sources without an accessible knowledge connector (the
//   discovery path passes `hasKnowledgeConnectors` it already computed;
//   the single-tool path checks it in isDynamicallyAvailableArchestraTool).
// RBAC and the dynamic-access gates still apply on top.
function isExcludedFromDiscovery(
  toolName: string,
  options?: { hasKnowledgeConnectors: boolean },
): boolean {
  if (toolName.startsWith("agent__")) {
    return true;
  }
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  if (shortName == null) {
    return false; // third-party MCP tool — discoverable
  }
  if (
    shortName === TOOL_SEARCH_TOOLS_SHORT_NAME ||
    shortName === TOOL_RUN_TOOL_SHORT_NAME
  ) {
    return true;
  }
  if (shortName === TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME) {
    return !options?.hasKnowledgeConnectors;
  }
  return !isBuiltInFeatureEnabled(shortName);
}

// Whether a built-in's feature group is live under the current deployment
// config, mirroring the registration/execution gates in index.ts
// (getArchestraMcpTools + executeArchestraTool): the sandbox group (runtime +
// persistent-files) follows the skills-sandbox flag (see
// isSandboxToolEnabled). Everything else — including the skill, app, and
// Projects tools, which are registered unconditionally — is always on.
function isBuiltInFeatureEnabled(shortName: string): boolean {
  if (isSandboxArchestraToolShortName(shortName)) {
    return isSandboxToolEnabled(shortName);
  }
  return true;
}

async function getAccessibleTools(
  userId: string,
  organizationId: string,
  environmentId: string | null,
  name?: string,
): Promise<Tool[]> {
  return ToolModel.getMcpToolsAccessibleToUser({
    userId,
    organizationId,
    environmentId,
    isAdmin: await userIsCatalogAdmin(userId, organizationId),
    name,
  });
}

// Catalog visibility uses the same admin notion as the catalog list endpoint
// (routes/internal-mcp-catalog.ts): mcpServerInstallation:admin sees all
// catalogs in the organization, including team-scoped ones.
/** @public — shared with the app-assignable tool resolver so both surfaces
 * derive catalog visibility from the same admin notion. */
export function userIsCatalogAdmin(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  return userHasPermission(
    userId,
    organizationId,
    "mcpServerInstallation",
    "admin",
  );
}
