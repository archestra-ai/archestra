import {
  ARCHESTRA_TOOL_SHORT_NAMES,
  type ArchestraToolShortName,
  getArchestraToolFullName,
  isProjectsFileArchestraToolShortName,
  isSandboxArchestraToolShortName,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
} from "@archestra/shared";
import { userHasPermission } from "@/auth/utils";
import config from "@/config";
import { knowledgeSourceAccessControlService } from "@/knowledge-base/source-access-control";
import { AgentModel, KnowledgeBaseConnectorModel, ToolModel } from "@/models";
import type { Tool } from "@/types";
import { archestraMcpBranding } from "./branding";
import { filterToolNamesByPermission } from "./rbac";

// Dynamic tool access: when an agent's "access all tools" setting is on, the
// dispatch surface (search_tools / run_tool) is relaxed from "tools assigned to
// the agent" to "tools the user can access" — discovery spans every MCP catalog
// the user can access plus the knowledge sources visible to them, and run_tool
// executes such a tool directly without assigning it. Which credential the
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

  // Resolve the name within the user-accessible tool set (tool names are only
  // unique per catalog, so a global name lookup could land on a row in a
  // catalog the user cannot access).
  const accessible = await getAccessibleTools(
    ctx.userId,
    ctx.organizationId,
    ctx.agentEnvironmentId,
    toolName,
  );
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
 * Whether an unassigned Archestra built-in may execute for this agent/user
 * anyway: the sandbox runtime tools when the sandbox runtime is on, the
 * persistent-files (Projects) tools when the Projects feature is on (see
 * isSandboxToolEnabled), and query_knowledge_sources when the user can access at
 * least one knowledge connector. The caller (executeArchestraTool) has already
 * enforced the tool's RBAC permission; this adds the dynamic-access gates on
 * top. Every other built-in stays assignment-gated.
 */
export async function isDynamicallyAvailableArchestraTool(params: {
  toolName: string;
  agentId: string;
  userId?: string;
  organizationId?: string;
}): Promise<boolean> {
  const shortName = archestraMcpBranding.getToolShortName(params.toolName);
  if (shortName == null) {
    return false;
  }
  const isKnowledgeQuery =
    shortName === TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME;
  const isSandboxTool = isSandboxToolEnabled(shortName);
  if (!isKnowledgeQuery && !isSandboxTool) {
    return false;
  }
  const ctx = await dynamicAccessContext(params);
  if (!ctx) {
    return false;
  }
  return isKnowledgeQuery
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
 * catalog the user can access, the sandbox built-ins when the feature is on,
 * and query_knowledge_sources when the user can access at least one knowledge
 * connector (see `isExcludedFromDiscovery`). Every other Archestra built-in
 * stays assignment-gated and is excluded.
 */
export async function getUnassignedDiscoverableTools(params: {
  assignedToolNames: Set<string>;
  agentId: string;
  userId?: string;
  organizationId?: string;
}): Promise<Tool[]> {
  const { assignedToolNames } = params;
  const ctx = await dynamicAccessContext(params);
  if (!ctx) {
    return [];
  }

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
      !isExcludedFromDiscovery(tool.name, { hasKnowledgeConnectors }),
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
// the current deployment config. The runtime tools
// (run_command/upload_file/download_file) follow the skills-sandbox runtime
// flag; the persistent-files (Projects) tools follow the Projects flag in
// addition to the runtime flag — they don't materialize a Dagger container, but
// execution still requires the runtime (see sandbox.ts `ensureUsable`), so
// exposing them only with both flags on mirrors the registration gate in
// index.ts. Non-sandbox tools are never enabled by this predicate.
function isSandboxToolEnabled(shortName: string): boolean {
  if (isProjectsFileArchestraToolShortName(shortName)) {
    return config.skillsSandbox.enabled && config.projects.enabled;
  }
  return (
    config.skillsSandbox.enabled && isSandboxArchestraToolShortName(shortName)
  );
}

// Mirrors the search-space exclusions: Archestra built-ins stay
// assignment-gated, and `agent__`-named rows (proxy-discovered delegation
// artifacts) are hidden from search, so they must not be dynamically runnable
// either.
//
// EXCEPTIONS riding the relaxation:
// - the sandbox runtime tools (run_command/upload_file/download_file) when the
//   sandbox runtime is on, and the persistent-files tools
//   (search_files/read_file/save_file/edit_file/delete_file) when the
//   Projects feature is on, so a user with sandbox:execute can discover and run
//   them without a manual assignment (see isSandboxToolEnabled);
// - query_knowledge_sources when the user can access a knowledge connector
//   (the discovery path passes `hasKnowledgeConnectors` it already computed;
//   the single-tool path checks it in isDynamicallyAvailableArchestraTool).
// RBAC and the dynamic-access gates still apply to both.
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
  if (shortName === TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME) {
    return !options?.hasKnowledgeConnectors;
  }
  return !isSandboxToolEnabled(shortName);
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
function userIsCatalogAdmin(
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
