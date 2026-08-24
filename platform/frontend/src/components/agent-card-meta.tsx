import { Badge } from "@/components/ui/badge";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

/**
 * The at-a-glance facts an agent card carries under its title, shared by the
 * Agents and MCP Gateways lists so the two grids stay legible as one thing.
 *
 * Both lists are fed by `GET /api/agents`, so these read straight off the row
 * with no extra request. The shape is structural rather than the generated
 * response type because the two pages narrow that type differently.
 */
type AgentCardAccess = {
  accessAllTools: boolean;
  accessAllSubagents: boolean;
  tools: Array<{ delegateToAgentId?: string | null }>;
};

/**
 * Counts, not names: the card has room for a number, and the detail page is
 * one click away for the list. "All" is its own answer — an Auto-mode agent
 * has no per-tool rows at all, so counting them would read "0" while the agent
 * reaches the whole catalogue.
 *
 * Delegation tools are unique per target agent (a unique index on
 * `tools.delegate_to_agent_id`), so counting the rows counts the subagents.
 */
export function AgentAccessBadges({ agent }: { agent: AgentCardAccess }) {
  const toolCount = agent.tools.filter(
    (tool) => !tool.delegateToAgentId,
  ).length;
  const subagentCount = agent.tools.filter(
    (tool) => tool.delegateToAgentId,
  ).length;

  return (
    <>
      <Badge variant="outline">
        {agent.accessAllTools ? "All tools" : countLabel(toolCount, "tool")}
      </Badge>
      <Badge variant="outline">
        {agent.accessAllSubagents
          ? "All subagents"
          : countLabel(subagentCount, "subagent")}
      </Badge>
    </>
  );
}

/**
 * When the agent last did anything — an MCP request routed through it or an
 * LLM call made on its behalf. "Never" is a real answer here, and a useful
 * one: it is how an abandoned agent shows up in a long list.
 */
export function AgentLastUsedFooter({
  lastUsedAt,
}: {
  lastUsedAt?: string | Date | null;
}) {
  return (
    <span>
      Last used{" "}
      {formatRelativeTimeFromNow(lastUsedAt ?? null, { neverLabel: "never" })}
    </span>
  );
}

function countLabel(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
