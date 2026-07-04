import { AGENT_TOOL_PREFIX, ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import {
  dynamicAccessContext,
  userIsCatalogAdmin,
} from "@/archestra-mcp-server/dynamic-tools";
import { filterToolNamesByPermission } from "@/archestra-mcp-server/rbac";
import { ToolModel } from "@/models";
import type { Tool } from "@/types";

/**
 * Resolve the tools an app may be assigned by name, mapped to the single
 * canonical row per name — the SAME row `search_tools` shows and `run_tool` /
 * `archestra.tools.call` execute. This is the one place app tool assignment
 * (`resolveAppToolsByName`) and app grounding (`buildAppCapabilityContext`)
 * share, so the name the model discovers, the row it assigns, and the row the
 * app runtime dispatches can never disagree.
 *
 * `tools.name` (`<server>__<tool>`) is unique only per catalog, so a name can
 * back more than one row (e.g. an installed catalog plus a legacy/global
 * duplicate). We mirror `search_tools`'s candidate set and ordering: the agent's
 * assigned tools (always, no dynamic-access gate) plus — only when the agent has
 * "access all tools" — the tools the user can otherwise reach; assigned rows win
 * over discoverable ones, and among discoverable rows the newest wins
 * (`getMcpToolsAccessibleToUser` returns them newest-first).
 *
 * Discoverable candidates are install-scoped to what the user can actually reach
 * and run; assigned tools are reachable through their assignment without a
 * separate install. Both are fenced to `environmentId` (the assignment target:
 * the org default for scaffold_app, the app's bound env for set_app_tools),
 * exclude Archestra built-ins (apps reach the data store through
 * archestra.storage), and are RBAC-filtered the same way search/grounding are.
 */
export async function resolveAppAssignableToolRows(params: {
  agentId: string;
  userId: string;
  organizationId: string;
  environmentId: string | null;
}): Promise<Map<string, Tool>> {
  const { agentId, userId, organizationId, environmentId } = params;

  const [assignedTools, gate] = await Promise.all([
    ToolModel.getMcpToolsByAgent(agentId),
    dynamicAccessContext({ agentId, userId, organizationId }),
  ]);

  // Assigned tools are assignable through their assignment without a separate
  // discoverable install, but must still be org-visible and in the assignment-
  // target environment (getMcpToolsByAgent scopes to the AGENT's env, which can
  // differ from the app's env; it also does not exclude a foreign-org catalog).
  const assignedAssignableIds = await ToolModel.filterAppAssignableToolIds(
    organizationId,
    assignedTools.map((tool) => tool.id),
    environmentId,
  );

  // Discoverable universe: only when the agent has "access all tools" (matching
  // search_tools), install-scoped and newest-first, fenced to the target env.
  const discoverableTools = gate
    ? await ToolModel.getMcpToolsAccessibleToUser({
        userId,
        organizationId,
        environmentId,
        isAdmin: await userIsCatalogAdmin(userId, organizationId),
      })
    : [];

  const byName = new Map<string, Tool>();
  for (const tool of assignedTools) {
    if (assignedAssignableIds.has(tool.id) && !byName.has(tool.name)) {
      byName.set(tool.name, tool);
    }
  }
  for (const tool of discoverableTools) {
    if (isAppAssignable(tool) && !byName.has(tool.name)) {
      byName.set(tool.name, tool);
    }
  }

  const permitted = await filterToolNamesByPermission(
    [...byName.keys()],
    userId,
    organizationId,
  );
  for (const name of [...byName.keys()]) {
    if (!permitted.has(name)) {
      byName.delete(name);
    }
  }

  return byName;
}

function isAppAssignable(tool: Tool): boolean {
  return (
    tool.catalogId != null &&
    tool.catalogId !== ARCHESTRA_MCP_CATALOG_ID &&
    // Reserved delegation-tool prefix, hidden from search_tools; a catalog tool
    // reusing it must not be assignable through this discovery-matched path.
    !tool.name.startsWith(AGENT_TOOL_PREFIX) &&
    !tool.clonedPendingDiscovery
  );
}
