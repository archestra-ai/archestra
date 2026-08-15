import AgentModel from "@/models/agent";
import AgentToolModel from "@/models/agent-tool";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import McpServerModel from "@/models/mcp-server";
import ToolModel from "@/models/tool";
import { ApiError } from "@/types";
import type { AgentCredentialReadiness, ReadinessAgent } from "@/types/agent";

/**
 * For each agent that enforces a missing-credential behavior, the MCP servers
 * the caller cannot reach.
 *
 * A server is reachable when the agent's assignment supplies the credential for
 * everyone — a static pin to a live install, or enterprise-managed credentials
 * the pod fetches itself — or when the server needs no credential at all
 * (built-in servers and apps), or when the catalog pins one default connection
 * every caller shares. Only what is left over is resolved per caller, and that
 * is the case where the caller needs their own, a team's, or an org-wide
 * install.
 *
 * Mirroring the assignment's credential mode matters: the runtime honours a
 * static pin regardless of who is calling, so treating those servers as
 * per-caller would refuse people whose tool calls would have worked.
 *
 * Agents left on `allow` are filtered out before any lookup runs, so the
 * default configuration does no work here beyond the single row read that
 * establishes the behavior.
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
  const toolsByAgent = new Map<string, { id: string; catalogId: string }[]>();
  await Promise.all(
    enforcing.map(async (agent) => {
      const tools = await ToolModel.getMcpToolsByAgent(agent.id);
      toolsByAgent.set(
        agent.id,
        tools.flatMap((tool) =>
          tool.catalogId ? [{ id: tool.id, catalogId: tool.catalogId }] : [],
        ),
      );
    }),
  );

  const assignmentsByAgent = await AgentToolModel.findAssignmentsByAgents(
    enforcing.map((agent) => agent.id),
  );

  const allCatalogIds = [
    ...new Set([...toolsByAgent.values()].flat().map((tool) => tool.catalogId)),
  ];
  const catalogs = await InternalMcpCatalogModel.getByIds(allCatalogIds);

  // One liveness read covers both kinds of pin. A pin whose install was since
  // uninstalled is not a credential — the runtime falls back to resolving per
  // caller, so readiness has to fall back with it.
  const pinnedServerIds = [
    ...new Set([
      ...[...assignmentsByAgent.values()]
        .flat()
        .flatMap((assignment) =>
          assignment.credentialResolutionMode === "static" &&
          assignment.mcpServerId
            ? [assignment.mcpServerId]
            : [],
        ),
      ...[...catalogs.values()].flatMap((catalog) =>
        catalog.dynamicConnectionMcpServerId
          ? [catalog.dynamicConnectionMcpServerId]
          : [],
      ),
    ]),
  ];
  const liveServers = await McpServerModel.findByIdsBasic(pinnedServerIds);
  // Keyed by catalog as well as id: the runtime revalidates a pin against the
  // catalog it is serving, so a pin left pointing at another catalog's install
  // is no credential at all and has to fall back with the rest.
  const liveServerCatalogIds = new Map(
    liveServers.map((server) => [server.id, server.catalogId]),
  );
  const isLivePinFor = (
    serverId: string | null | undefined,
    catalogId: string,
  ) => !!serverId && liveServerCatalogIds.get(serverId) === catalogId;

  // Catalogs still resolved per caller, per agent — the same catalog can be
  // pinned by one agent and left dynamic by another.
  const perCallerCatalogsByAgent = new Map<string, Set<string>>();
  for (const agent of enforcing) {
    const assignmentByToolId = new Map(
      (assignmentsByAgent.get(agent.id) ?? []).map((assignment) => [
        assignment.toolId,
        assignment,
      ]),
    );
    const perCaller = new Set<string>();

    for (const tool of toolsByAgent.get(agent.id) ?? []) {
      const catalog = catalogs.get(tool.catalogId);
      if (!catalog) continue;
      if (isCredentialLess(catalog)) continue;

      const assignment = assignmentByToolId.get(tool.id);
      // Enterprise-managed pods fetch their own credentials from the identity
      // provider, so no caller can be missing one. This stays true even when
      // the catalog has no install left for the pod to run on: that case fails
      // at call time exactly as it did before this setting existed, which is a
      // far better outcome than refusing a caller whose tools would have run.
      if (assignment?.credentialResolutionMode === "enterprise_managed") {
        continue;
      }
      if (
        assignment?.credentialResolutionMode === "static" &&
        isLivePinFor(assignment.mcpServerId, tool.catalogId)
      ) {
        continue;
      }
      if (isLivePinFor(catalog.dynamicConnectionMcpServerId, tool.catalogId)) {
        continue;
      }

      perCaller.add(tool.catalogId);
    }

    perCallerCatalogsByAgent.set(agent.id, perCaller);
  }

  const connectedCatalogIds =
    await McpServerModel.getCatalogIdsWithAccessibleInstall({
      userId,
      catalogIds: [
        ...new Set(
          [...perCallerCatalogsByAgent.values()].flatMap((s) => [...s]),
        ),
      ],
    });

  return enforcing.map((agent) => ({
    agentId: agent.id,
    missingCredentialBehavior: agent.missingCredentialBehavior,
    missingConnections: [...(perCallerCatalogsByAgent.get(agent.id) ?? [])]
      .filter((catalogId) => !connectedCatalogIds.has(catalogId))
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

/** Built-in servers and apps run in-process with no stored credential. */
function isCredentialLess(catalog: { serverType: string }): boolean {
  return catalog.serverType === "builtin" || catalog.serverType === "app";
}
