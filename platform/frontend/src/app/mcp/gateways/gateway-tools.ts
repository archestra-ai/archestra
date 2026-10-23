/** A gateway's tool rows, as the list and single-gateway reads both carry them. */
export interface GatewayToolRow {
  name: string;
  /** Set when the row delegates to a subagent rather than exposing a tool. */
  delegateToAgentId: string | null;
}

/** Names of the tools a gateway exposes by assignment, leaving out subagents. */
export function gatewayToolNames(tools: GatewayToolRow[]): string[] {
  return tools
    .filter((tool) => !tool.delegateToAgentId)
    .map((tool) => tool.name);
}

/** Names of the subagents a gateway delegates to. */
export function gatewaySubagentNames(tools: GatewayToolRow[]): string[] {
  return tools
    .filter((tool) => tool.delegateToAgentId)
    .map((tool) => tool.name);
}
