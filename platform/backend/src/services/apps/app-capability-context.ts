import { ARCHESTRA_APP_SDK_SUMMARY } from "@/archestra-mcp-server/app-authoring-guidance";
import { AgentModel } from "@/models";
import { resolveAppAssignableToolRows } from "./app-assignable-tools";

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
 * Assemble the real capabilities an MCP App can be grounded in: the MCP tools
 * the requesting user/agent may actually assign to an app (RBAC-filtered and
 * narrowed to the app-assignable set), plus the window.archestra SDK summary.
 *
 * The tool set is the same candidate space search_tools exposes — the agent's
 * assigned MCP tools plus, when the agent has dynamic access, the tools the
 * user can otherwise reach — resolved through {@link resolveAppAssignableToolRows},
 * the exact surface `resolveAppToolsByName` assigns from. Each name maps to its
 * canonical row (RBAC-filtered, install-scoped, Archestra built-ins excluded
 * because apps reach the data store through archestra.storage), so the grounding
 * lists exactly the names that can really be attached and each description comes
 * from the row that would actually be assigned and run.
 */
export async function buildAppCapabilityContext(params: {
  userId: string;
  organizationId: string;
  /** The chat agent making the request (for agent-scoped tool resolution). */
  agentId: string;
}): Promise<AppCapabilityContext> {
  const { agentId, organizationId, userId } = params;

  const byName = await resolveAppAssignableToolRows({
    agentId,
    userId,
    organizationId,
    environmentId: await AgentModel.findEnvironmentId(agentId),
  });

  const tools: AppCapabilityTool[] = [...byName.values()]
    .map((tool) => ({ name: tool.name, description: tool.description ?? "" }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { tools, sdkSummary: ARCHESTRA_APP_SDK_SUMMARY };
}
