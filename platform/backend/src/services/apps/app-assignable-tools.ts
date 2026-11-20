import { AGENT_TOOL_PREFIX, ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import {
  dynamicAccessContext,
  userIsCatalogAdmin,
} from "@/archestra-mcp-server/dynamic-tools";
import { filterToolNamesByPermission } from "@/archestra-mcp-server/rbac";
import { InternalMcpCatalogModel, ToolModel } from "@/models";
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
 * (`getMcpToolsAccessibleToUser` returns them newest-first). When the same name
 * exists in the app's environment and in Default, the app's environment wins:
 * both are legal, and a call from this app must reach its own server.
 *
 * Discoverable candidates follow catalog visibility, not installs — a visible
 * catalog whose server the user has not connected yet stays assignable, and the
 * runtime surfaces the auth-required connect link per viewer; assigned tools
 * are reachable through their assignment without a separate install. Both are
 * fenced to `environmentId` (the assignment target: the authoring agent's env
 * for scaffold_app — which is where the app gets bound — and the app's bound
 * env for set_app_tools) plus the Default-environment baseline every app may
 * draw from, exclude Archestra built-ins (apps reach the data store through
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
        includeDefaultEnvironment: true,
        isAdmin: await userIsCatalogAdmin(userId, organizationId),
      })
    : [];

  const candidates: Tool[] = [];
  const seen = new Set<string>();
  for (const tool of assignedTools) {
    if (assignedAssignableIds.has(tool.id) && !seen.has(tool.id)) {
      seen.add(tool.id);
      candidates.push(tool);
    }
  }
  for (const tool of discoverableTools) {
    if (isAppAssignable(tool) && !seen.has(tool.id)) {
      seen.add(tool.id);
      candidates.push(tool);
    }
  }
  // Within one source (assigned, then discoverable) the lists are already
  // newest-first. A tool in the app's own environment still beats a Default
  // tool of the same name, whichever list it came from.
  const environments = await catalogEnvironments(
    candidates.map((tool) => tool.catalogId),
  );
  const byName = new Map<string, Tool>();
  const preferred = candidates.filter(
    (tool) =>
      environmentId !== null &&
      tool.catalogId !== null &&
      environments.get(tool.catalogId) === environmentId,
  );
  for (const tool of [...preferred, ...candidates]) {
    if (!byName.has(tool.name)) byName.set(tool.name, tool);
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

/** Catalog id to its environment (null is Default). Missing ids stay absent. */
async function catalogEnvironments(
  catalogIds: Array<string | null>,
): Promise<Map<string, string | null>> {
  const ids = [
    ...new Set(catalogIds.filter((id): id is string => id !== null)),
  ];
  if (ids.length === 0) return new Map();
  const rows = await InternalMcpCatalogModel.findEnvironmentIdsByIds(ids);
  return new Map(rows.map((row) => [row.id, row.environmentId]));
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
