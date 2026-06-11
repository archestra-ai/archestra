import {
  ARCHESTRA_MCP_CATALOG_ID,
  ARCHESTRA_TOOL_SHORT_NAMES,
  type ArchestraToolShortName,
  getArchestraToolFullName,
  isSandboxArchestraToolShortName,
} from "@archestra/shared";
import {
  getAgentTypePermissionChecker,
  requireAgentModifyPermission,
} from "@/auth/agent-type-permissions";
import { userHasPermission } from "@/auth/utils";
import config from "@/config";
import logger from "@/logging";
import { AgentModel, OrganizationModel, TeamModel, ToolModel } from "@/models";
import { assignToolToAgent } from "@/services/agent-tool-assignment";
import { ApiError, type Tool } from "@/types";
import { archestraMcpBranding } from "./branding";
import { filterToolNamesByPermission } from "./rbac";

// Skills routinely reference tools that nobody assigned to the agent, so the
// dispatch surface (search_tools / run_tool) is relaxed from "tools assigned to
// the agent" to "tools the user could assign": discovery spans every catalog
// the user can access. Running such a tool is NOT silent — the chat proposes
// granting it (an approval card) and the user confirms, which assigns it via the
// normal assign endpoint before the call resumes. Users who cannot modify the
// agent get a recovery message telling them to ask an admin instead.
// The org-level "allow tool auto-assignment" security setting restores the
// strict behavior for organizations where catalog tool names must not be
// exposed beyond the agents' assigned toolsets.

type ToolGrantOutcome =
  /** Tool is visible to the user AND they may modify the agent — propose granting. */
  | "grantable"
  /** Tool exists and is visible to the user, but they cannot modify the agent. */
  | "forbidden"
  /** Tool unknown, not catalog-backed, or its catalog is not visible to the user. */
  | "unavailable";

/**
 * Decide whether an accessible-but-unassigned tool can be granted to the agent,
 * applying the same authorization as a manual assignment (catalog access +
 * permission to modify the agent) WITHOUT writing the assignment.
 */
export async function resolveToolGrant(params: {
  toolName: string;
  agentId: string;
  userId?: string;
  organizationId?: string;
}): Promise<ToolGrantOutcome> {
  return (await evaluateToolGrant(params)).outcome;
}

/**
 * Resolve a tool by name and, if the user may grant it, assign it to the agent.
 * The user-facing counterpart of the old silent first-use assignment: invoked
 * from the grant endpoint after the user confirms the proposal in chat. Resolves
 * the same row resolveToolGrant judged, so the assignment matches what was
 * proposed (and a reserved built-in name can only resolve to the Archestra row).
 */
export async function grantToolToAgent(params: {
  toolName: string;
  agentId: string;
  userId?: string;
  organizationId?: string;
}): Promise<ToolGrantOutcome> {
  const { outcome, toolId } = await evaluateToolGrant(params);
  if (outcome !== "grantable" || toolId == null) {
    return outcome;
  }
  // Late-bound resolution: credentials and execution target resolve at call
  // time, so no MCP server pinning is needed at assignment time.
  const result = await assignToolToAgent({
    agentId: params.agentId,
    toolId,
    resolveAtCallTime: true,
  });
  if (result !== null && result !== "duplicate" && result !== "updated") {
    logger.warn(
      { agentId: params.agentId, toolName: params.toolName, toolId },
      "granting tool to agent failed validation",
    );
    return "unavailable";
  }
  return "grantable";
}

async function evaluateToolGrant(params: {
  toolName: string;
  agentId: string;
  userId?: string;
  organizationId?: string;
}): Promise<{ outcome: ToolGrantOutcome; toolId?: string }> {
  const { agentId } = params;
  // Resolve short Archestra names (e.g. `run_command`) to their canonical full
  // name exactly as run_tool's dispatch does, so the approval gate, the grant
  // write, and the stored tool row all agree on which row is being granted.
  const toolName = resolveRunToolTargetName(params.toolName);
  if (isExcludedFromDiscovery(toolName)) {
    return { outcome: "unavailable" };
  }
  const ctx = await relaxationContext(params.userId, params.organizationId);
  if (!ctx) {
    return { outcome: "unavailable" };
  }
  const { organizationId, userId } = ctx;

  // Resolve the name within the user-accessible tool set (tool names are only
  // unique per catalog, so a global name lookup could land on a row in a
  // catalog the user cannot access). A sandbox built-in must resolve to its real
  // Archestra-catalog row: a third-party catalog row reusing the reserved
  // `archestra__run_command` name must not be treated as the built-in.
  const accessible = await getAccessibleTools(userId, organizationId, toolName);
  const tool = archestraMcpBranding.isToolName(toolName)
    ? accessible.find((row) => row.catalogId === ARCHESTRA_MCP_CATALOG_ID)
    : accessible[0];
  if (!tool) {
    return { outcome: "unavailable" };
  }

  // Per-tool RBAC, mirroring the search surface (search-tools.ts filters the
  // same way): catalog visibility alone is not enough for built-ins. The
  // Archestra catalog is visible to everyone, so a sandbox tool must still pass
  // its `sandbox:execute` check — otherwise a user who can modify the agent but
  // cannot run the sandbox could persistently assign run_command to it.
  const permitted = await filterToolNamesByPermission(
    [tool.name],
    userId,
    organizationId,
  );
  if (!permitted.has(tool.name)) {
    return { outcome: "unavailable" };
  }

  const target = (await AgentModel.findByIdsForPermissionCheck([agentId])).get(
    agentId,
  );
  if (!target) {
    return { outcome: "unavailable" };
  }

  const [checker, userTeamIds] = await Promise.all([
    getAgentTypePermissionChecker({ userId, organizationId }),
    TeamModel.getUserTeamIds(userId),
  ]);
  try {
    checker.require(target.agentType, "update");
    requireAgentModifyPermission({
      checker,
      agentType: target.agentType,
      agentScope: target.scope,
      agentAuthorId: target.authorId,
      agentTeamIds: target.teamIds,
      userTeamIds,
      userId,
    });
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 403) {
      return { outcome: "forbidden" };
    }
    throw error;
  }

  return { outcome: "grantable", toolId: tool.id };
}

const ARCHESTRA_SHORT_NAME_SET = new Set<string>(ARCHESTRA_TOOL_SHORT_NAMES);

/**
 * Resolve a run_tool target name to its canonical form (Archestra short names
 * like `run_command` → `archestra__run_command`; everything else unchanged),
 * mirroring run_tool's own resolution so assignment/grant checks line up.
 */
export function resolveRunToolTargetName(requestedName: string): string {
  const isArchestraPrefixed = archestraMcpBranding.isToolName(requestedName);
  if (!isArchestraPrefixed && ARCHESTRA_SHORT_NAME_SET.has(requestedName)) {
    return getArchestraToolFullName(requestedName as ArchestraToolShortName);
  }
  return requestedName;
}

/**
 * Whether a run_tool target should trigger a "grant this tool to the agent"
 * approval in chat: it must be unassigned (an assigned tool only ever needs a
 * policy approval) and grantable by the current user. Used by the chat
 * approval gate; non-chat callers never reach it.
 */
export async function isToolGrantApprovable(params: {
  toolName: string;
  agentId: string;
  userId?: string;
  organizationId?: string;
}): Promise<boolean> {
  const resolvedName = resolveRunToolTargetName(params.toolName);
  const assigned = await ToolModel.getAssignedToolNames(params.agentId);
  if (assigned.has(resolvedName)) {
    return false;
  }
  const outcome = await resolveToolGrant({
    toolName: resolvedName,
    agentId: params.agentId,
    userId: params.userId,
    organizationId: params.organizationId,
  });
  return outcome === "grantable";
}

/**
 * Tools the user can access that are not yet assigned to the agent — the widened
 * portion of the search_tools search space. Third-party MCP tools from every
 * catalog the user can access, plus the sandbox built-ins when the feature is on
 * (see `isExcludedFromDiscovery`). Every other Archestra built-in stays
 * assignment-gated and is excluded.
 */
export async function getUnassignedDiscoverableTools(params: {
  assignedToolNames: Set<string>;
  userId?: string;
  organizationId?: string;
}): Promise<Tool[]> {
  const { assignedToolNames } = params;
  const ctx = await relaxationContext(params.userId, params.organizationId);
  if (!ctx) {
    return [];
  }

  const accessibleTools = await getAccessibleTools(
    ctx.userId,
    ctx.organizationId,
  );
  return accessibleTools.filter(
    (tool) =>
      !assignedToolNames.has(tool.name) && !isExcludedFromDiscovery(tool.name),
  );
}

// === Internal helpers ===

// Single gate shared by the search widening and the auto-assignment so the
// two surfaces cannot drift apart: relaxation needs a real authenticated user
// (org/team-token sessions and the internal "system" user keep the strict
// assigned-tools-only behavior) and the org's "allow tool auto-assignment"
// security setting on. Returns the validated user/org pair, or null when the
// strict behavior applies.
async function relaxationContext(
  userId: string | undefined,
  organizationId: string | undefined,
): Promise<{ userId: string; organizationId: string } | null> {
  if (!userId || !organizationId || userId === "system") {
    return null;
  }
  if (!(await OrganizationModel.getAllowToolAutoAssignment(organizationId))) {
    return null;
  }
  return { userId, organizationId };
}

// Mirrors the search-space exclusions: Archestra built-ins stay
// assignment-gated, and `agent__`-named rows (proxy-discovered delegation
// artifacts) are hidden from search, so they must not be auto-assignable
// either.
//
// EXCEPTION: the sandbox tools (run_command/upload_file/download_file) ride this
// relaxation when the sandbox feature is on, so a user with sandbox:execute can
// discover and run them without a manual assignment. RBAC (sandbox:execute) and
// the org allow-tool-auto-assignment kill-switch still gate them. CONCERN: this
// widens the otherwise assignment-gated built-in surface — a dedicated sandbox
// opt-in would be cleaner than riding the generic relaxation.
function isExcludedFromDiscovery(toolName: string): boolean {
  if (toolName.startsWith("agent__")) {
    return true;
  }
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  if (shortName == null) {
    return false; // third-party MCP tool — discoverable
  }
  return !(
    config.skillsSandbox.enabled && isSandboxArchestraToolShortName(shortName)
  );
}

async function getAccessibleTools(
  userId: string,
  organizationId: string,
  name?: string,
): Promise<Tool[]> {
  return ToolModel.getMcpToolsAccessibleToUser({
    userId,
    organizationId,
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
