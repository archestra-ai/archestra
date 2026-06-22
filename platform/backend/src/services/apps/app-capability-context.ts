import { getUnassignedDiscoverableTools } from "@/archestra-mcp-server/dynamic-tools";
import { filterToolNamesByPermission } from "@/archestra-mcp-server/rbac";
import { AgentModel, ToolModel } from "@/models";

interface AppCapabilityTool {
  /** Full MCP tool name as used by archestra.tools.call(...). */
  name: string;
  description: string;
}

interface AppCapabilityContext {
  /** MCP tools the user can access/assign to an app, RBAC-filtered. */
  tools: AppCapabilityTool[];
  /** Compact human-readable summary of the window.archestra SDK surface. */
  sdkSummary: string;
}

/**
 * Compact, accurate description of the `window.archestra` SDK an app's HTML is
 * authored against. A prompt ingredient for the authoring model — kept terse so
 * it can be fed alongside the (potentially long) capability tool list without
 * crowding it out. Mirrors the runtime surface injected by app-sdk-injection.
 */
const ARCHESTRA_APP_SDK_SUMMARY = `window.archestra is injected at render time (await archestra.ready before the first call; every method is async). Surface:
- archestra.user — the authenticated viewer {id, name}, readable after ready.
- archestra.storage.user.{get,set,list,delete} — per-viewer JSON key/value store; archestra.storage.shared.* is one store all viewers share.
- archestra.tools.call(name, args) — invoke an assigned MCP tool as the viewer with their credentials; archestra.tools.list() returns the assigned tools.
- archestra.llm.complete(prompt, {system, jsonMode}) — one host LLM completion over data the app already has (not a data source).
- archestra.ui.openLink(url) and archestra.ui.requestDisplayMode(mode) — reach the host; archestra.context is the running app's {appId, version}.
All external data must come through assigned MCP tools (the sandbox blocks network access).`;

/**
 * Assemble the real capabilities an MCP App can be grounded in: the MCP tools
 * the requesting user/agent may actually assign to an app (RBAC-filtered and
 * narrowed to the app-assignable set), plus the window.archestra SDK summary.
 *
 * The tool set is the same candidate space search_tools exposes — the agent's
 * assigned MCP tools plus, when the agent has dynamic access, the tools the
 * user can otherwise reach — RBAC-filtered the identical way, then narrowed to
 * the app-assignable rows (external catalog-backed tools; Archestra built-ins
 * are excluded because apps reach the data store through archestra.storage).
 * That narrowing reuses {@link ToolModel.findAppAssignableToolsByNames}, the
 * exact gate resolveAppToolsByName applies at assignment time, so the grounding
 * matches what can really be attached.
 */
export async function buildAppCapabilityContext(params: {
  userId: string;
  organizationId: string;
  /** The chat agent making the request (for agent-scoped tool resolution). */
  agentId: string;
}): Promise<AppCapabilityContext> {
  const { agentId, organizationId, userId } = params;

  const assignedTools = await ToolModel.getMcpToolsByAgent(agentId);
  const assignedNames = new Set(assignedTools.map((tool) => tool.name));
  const discoverableTools = await getUnassignedDiscoverableTools({
    assignedToolNames: assignedNames,
    agentId,
    userId,
    organizationId,
  });

  // First occurrence wins on duplicate names (assigned before discoverable),
  // matching the search_tools ordering so a name resolves to the same row's
  // description the model would otherwise see.
  const descriptionByName = new Map<string, string>();
  for (const tool of [...assignedTools, ...discoverableTools]) {
    if (!descriptionByName.has(tool.name)) {
      descriptionByName.set(tool.name, tool.description ?? "");
    }
  }

  const permittedNames = await filterToolNamesByPermission(
    [...descriptionByName.keys()],
    userId,
    organizationId,
  );
  const assignableRows = await ToolModel.findAppAssignableToolsByNames(
    organizationId,
    [...permittedNames].filter((name) => descriptionByName.has(name)),
    await AgentModel.findEnvironmentId(agentId),
  );

  // A name backed by more than one assignable row is ambiguous and cannot be
  // assigned by name (resolveAppToolsByName rejects it), so it is not a real
  // grounding capability — drop ambiguous names and keep unique ones.
  const rowCountByName = new Map<string, number>();
  for (const row of assignableRows) {
    if (row.clonedPendingDiscovery) {
      continue;
    }
    rowCountByName.set(row.name, (rowCountByName.get(row.name) ?? 0) + 1);
  }

  const tools: AppCapabilityTool[] = [...rowCountByName.entries()]
    .filter(([, count]) => count === 1)
    .map(([name]) => ({ name, description: descriptionByName.get(name) ?? "" }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { tools, sdkSummary: ARCHESTRA_APP_SDK_SUMMARY };
}
