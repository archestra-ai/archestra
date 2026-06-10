import {
  getAgentTypePermissionChecker,
  requireAgentModifyPermission,
} from "@/auth/agent-type-permissions";
import { userHasPermission } from "@/auth/utils";
import config from "@/config";
import logger from "@/logging";
import { AgentModel, TeamModel, ToolModel } from "@/models";
import { assignToolToAgent } from "@/services/agent-tool-assignment";
import type { Tool } from "@/types";
import { archestraMcpBranding } from "./branding";

// Skills routinely reference tools that nobody assigned to the agent, so the
// dispatch surface (search_tools / run_tool) is relaxed from "tools assigned to
// the agent" to "tools the user could assign": discovery spans every catalog
// the user can access, and run_tool assigns such a tool to the agent on first
// use when the user is allowed to modify the agent. Users who cannot modify
// the agent get a recovery message telling them to ask an admin instead.
// ARCHESTRA_AGENTS_TOOL_AUTO_ASSIGNMENT_DISABLED restores the strict behavior
// for deployments where catalog tool names must not be exposed beyond the
// agents' assigned toolsets.

type AutoAssignOutcome =
  /** Tool assigned to the agent (or already was) — proceed with dispatch. */
  | "assigned"
  /** Tool exists and is visible to the user, but they cannot modify the agent. */
  | "forbidden"
  /** Tool unknown, not catalog-backed, or its catalog is not visible to the user. */
  | "unavailable";

/**
 * Assign a catalog-backed tool to the agent on first use, applying the same
 * authorization as a manual assignment: the user must have access to the
 * tool's catalog and permission to modify the agent.
 */
export async function autoAssignToolToAgent(params: {
  toolName: string;
  agentId: string;
  userId?: string;
  organizationId?: string;
}): Promise<AutoAssignOutcome> {
  const { agentId, organizationId, toolName, userId } = params;
  if (
    config.agents.toolAutoAssignmentDisabled ||
    !userId ||
    !organizationId ||
    userId === "system"
  ) {
    return "unavailable";
  }

  // Resolve the name within the user-accessible tool set (tool names are only
  // unique per catalog, so a global name lookup could land on a row in a
  // catalog the user cannot access). This keeps the assigned row consistent
  // with what search_tools surfaced.
  const accessibleTools = await getAccessibleTools(userId, organizationId);
  const tool = accessibleTools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    return "unavailable";
  }

  const target = (await AgentModel.findByIdsForPermissionCheck([agentId])).get(
    agentId,
  );
  if (!target) {
    return "unavailable";
  }

  try {
    const checker = await getAgentTypePermissionChecker({
      userId,
      organizationId,
    });
    checker.require(target.agentType, "update");
    requireAgentModifyPermission({
      checker,
      agentType: target.agentType,
      agentScope: target.scope,
      agentAuthorId: target.authorId,
      agentTeamIds: target.teamIds,
      userTeamIds: await TeamModel.getUserTeamIds(userId),
      userId,
    });
  } catch {
    return "forbidden";
  }

  // Late-bound resolution: credentials and execution target resolve at call
  // time, so no MCP server pinning is needed at assignment time.
  const result = await assignToolToAgent({
    agentId,
    toolId: tool.id,
    resolveAtCallTime: true,
  });
  if (result !== null && result !== "duplicate" && result !== "updated") {
    logger.warn(
      { agentId, toolName, toolId: tool.id, userId, error: result.error },
      "auto-assigning tool to agent failed validation",
    );
    return "unavailable";
  }

  logger.info(
    { agentId, toolName, toolId: tool.id, userId, organizationId },
    "auto-assigned tool to agent on first use",
  );
  return "assigned";
}

/**
 * Third-party MCP tools from catalogs the user can access that are not yet
 * assigned to the agent. The widened portion of the search_tools search space;
 * Archestra built-ins stay assignment-gated and are excluded.
 */
export async function getUnassignedDiscoverableTools(params: {
  assignedToolNames: Set<string>;
  userId?: string;
  organizationId?: string;
}): Promise<Tool[]> {
  const { assignedToolNames, organizationId, userId } = params;
  if (
    config.agents.toolAutoAssignmentDisabled ||
    !userId ||
    !organizationId ||
    userId === "system"
  ) {
    return [];
  }

  const accessibleTools = await getAccessibleTools(userId, organizationId);
  return accessibleTools.filter(
    (tool) =>
      !assignedToolNames.has(tool.name) &&
      !archestraMcpBranding.isToolName(tool.name),
  );
}

// === Internal helpers ===

async function getAccessibleTools(
  userId: string,
  organizationId: string,
): Promise<Tool[]> {
  return ToolModel.getMcpToolsAccessibleToUser({
    userId,
    organizationId,
    isAdmin: await userIsCatalogAdmin(userId, organizationId),
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
