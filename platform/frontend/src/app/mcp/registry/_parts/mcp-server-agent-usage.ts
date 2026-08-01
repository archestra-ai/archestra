import type { archestraApiTypes } from "@archestra/shared";

type McpServerFromApi = archestraApiTypes.GetMcpServersResponses["200"][number];

/** An agent as the API reports it against one MCP server install. */
type ApiAgentUsage = NonNullable<McpServerFromApi["assignedAgents"]>[number];

/**
 * How an agent reaches the server: through an explicit tool assignment, or
 * implicitly because it is in auto mode (access to all tools).
 */
export type AgentUsageAccess = "assigned" | "auto";

export type AgentUsage = ApiAgentUsage & { access: AgentUsageAccess };

/**
 * Collapse every install of one catalog item into the distinct set of agents
 * that can reach it.
 *
 * Two things are deduped. Installs: the same agent can be assigned tools from
 * several installs of the catalog, and the auto-mode set is org-wide so it
 * rides on every install identically. Sections: an auto-mode agent may also
 * carry an explicit assignment (a legacy pin, or "auto except some"), which
 * would list it twice — the explicit assignment is the more specific fact, so
 * it wins and the agent drops out of the auto-mode list.
 */
export function deriveAgentUsage(
  serversForCatalog: Array<
    Pick<McpServerFromApi, "assignedAgents" | "autoModeAgents">
  >,
): {
  assigned: AgentUsage[];
  autoOnly: AgentUsage[];
  all: AgentUsage[];
  total: number;
} {
  const assigned = dedupeById(
    serversForCatalog.flatMap((server) => server.assignedAgents ?? []),
    "assigned",
  );
  const autoMode = dedupeById(
    serversForCatalog.flatMap((server) => server.autoModeAgents ?? []),
    "auto",
  );

  const assignedIds = new Set(assigned.map((agent) => agent.id));
  const autoOnly = autoMode.filter((agent) => !assignedIds.has(agent.id));

  return {
    assigned,
    autoOnly,
    all: [...assigned, ...autoOnly].sort(compareByName),
    total: assigned.length + autoOnly.length,
  };
}

/**
 * Personal agents are auto-seeded one per member, so every member's copy
 * carries the same name — a list of them reads as repeated "My Assistant" /
 * "My Gateway" rows. Attribute those to their owner; agents with a name their
 * author chose need no qualifier.
 */
export function agentOwnerLabel(agent: {
  scope: string;
  ownerEmail: string | null;
}): string | null {
  if (agent.scope !== "personal") return null;
  return agent.ownerEmail;
}

/** Human-readable kind, for the usage table's Type column. */
export function agentTypeLabel(agentType: string): string {
  switch (agentType) {
    case "mcp_gateway":
      return "MCP Gateway";
    case "llm_proxy":
      return "LLM Proxy";
    case "agent":
      return "Agent";
    default:
      // `profile` is the legacy type that served both gateway and proxy.
      return "Agent";
  }
}

function dedupeById(
  agents: ApiAgentUsage[],
  access: AgentUsageAccess,
): AgentUsage[] {
  const byId = new Map<string, AgentUsage>();
  for (const agent of agents) {
    if (!byId.has(agent.id)) byId.set(agent.id, { ...agent, access });
  }
  return [...byId.values()].sort(compareByName);
}

/**
 * Same-named personal agents are only distinguishable by owner, so the owner
 * is the tiebreaker — otherwise their relative order is undefined and the list
 * reshuffles between renders.
 */
function compareByName(a: AgentUsage, b: AgentUsage): number {
  return (
    a.name.localeCompare(b.name) ||
    (a.ownerEmail ?? "").localeCompare(b.ownerEmail ?? "") ||
    a.id.localeCompare(b.id)
  );
}
