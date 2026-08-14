import AgentModel from "@/models/agent";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import McpServerModel from "@/models/mcp-server";
import ToolModel from "@/models/tool";
import { ApiError } from "@/types";
import type { AgentCredentialReadiness, ReadinessAgent } from "@/types/agent";

/**
 * For each agent that enforces a missing-credential behavior, the MCP servers
 * the caller cannot reach. A server counts as reachable when the caller has any
 * live install of it (their own, a team's, or an org-wide one), when the server
 * pins a fixed credential every caller shares, or when it needs no credential
 * at all (built-in servers and apps).
 *
 * Agents left on `allow` are skipped entirely, so the default configuration
 * costs no extra queries.
 */
export async function getAgentCredentialReadiness(params: {
  agents: ReadinessAgent[];
  userId: string;
}): Promise<AgentCredentialReadiness[]> {
  const { agents, userId } = params;

  const enforcing = agents.filter(isEnforcing);
  if (enforcing.length === 0) return [];

  // Per-agent rather than one batched join: this reuses the exact tool list the
  // runtime resolves for the agent (environment isolation, uninstalled pins,
  // soft deletes), so the pre-flight answer cannot drift from what a tool call
  // would actually do. Only agents that opted into warn/block pay for it.
  const catalogIdsByAgent = new Map<string, string[]>();
  await Promise.all(
    enforcing.map(async (agent) => {
      const tools = await ToolModel.getMcpToolsByAgent(agent.id);
      catalogIdsByAgent.set(
        agent.id,
        [
          ...new Set(
            tools.flatMap((tool) => (tool.catalogId ? [tool.catalogId] : [])),
          ),
        ],
      );
    }),
  );

  const allCatalogIds = [
    ...new Set([...catalogIdsByAgent.values()].flat()),
  ];
  const catalogs = await InternalMcpCatalogModel.getByIds(allCatalogIds);

  const catalogsNeedingConnection = allCatalogIds.filter((catalogId) => {
    const catalog = catalogs.get(catalogId);
    if (!catalog) return false;
    return requiresCallerConnection(catalog);
  });

  const connectedCatalogIds =
    await McpServerModel.getCatalogIdsWithAccessibleInstall({
      userId,
      catalogIds: catalogsNeedingConnection,
    });

  const needsConnection = new Set(catalogsNeedingConnection);

  return enforcing.map((agent) => ({
    agentId: agent.id,
    missingCredentialBehavior: agent.missingCredentialBehavior,
    missingConnections: (catalogIdsByAgent.get(agent.id) ?? [])
      .filter(
        (catalogId) =>
          needsConnection.has(catalogId) && !connectedCatalogIds.has(catalogId),
      )
      .map((catalogId) => ({
        catalogId,
        catalogName: catalogs.get(catalogId)?.name ?? "Unknown server",
      }))
      .sort((a, b) => a.catalogName.localeCompare(b.catalogName)),
  }));
}

/**
 * Refuses the turn when the agent is set to `block` and the caller cannot reach
 * every MCP server it needs. Naming the servers in the error matters: the whole
 * point of blocking is that the caller learns what to connect instead of
 * watching a tool fail halfway through an answer.
 */
export async function assertCallerMayStartTurn(params: {
  agentId: string;
  userId: string;
}): Promise<void> {
  const agent = await AgentModel.findMissingCredentialEnforcement(
    params.agentId,
  );
  if (!agent || agent.missingCredentialBehavior !== "block") return;

  const [readiness] = await getAgentCredentialReadiness({
    agents: [agent],
    userId: params.userId,
  });
  const missing = readiness?.missingConnections ?? [];
  if (missing.length === 0) return;

  const names = missing.map((connection) => connection.catalogName).join(", ");
  throw new ApiError(
    403,
    `This agent requires a connection to ${names}. Connect ${
      missing.length === 1 ? "it" : "them"
    } in the MCP registry to start a conversation.`,
  );
}

// === internals ===

/**
 * `accessAllTools` ("Auto") agents resolve tools per caller from what that
 * caller can already reach, so there is never anything for them to be missing —
 * enforcing a behavior on one would block a conversation over nothing.
 */
function isEnforcing(agent: ReadinessAgent): boolean {
  return agent.missingCredentialBehavior !== "allow" && !agent.accessAllTools;
}

function requiresCallerConnection(catalog: {
  serverType: string;
  dynamicConnectionMcpServerId?: string | null;
}): boolean {
  // Built-in servers and apps run in-process with no stored credential.
  if (catalog.serverType === "builtin" || catalog.serverType === "app") {
    return false;
  }
  // A pinned default credential serves every caller, so nobody is missing one.
  return !catalog.dynamicConnectionMcpServerId;
}
