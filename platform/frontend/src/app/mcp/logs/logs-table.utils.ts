import { parseFullToolName } from "@shared";

type AgentNameSource = {
  id: string;
  name: string;
};

type McpToolCallRow = {
  agentId: string | null;
  mcpServerName?: string | null;
  toolCall?: { name?: string; arguments?: unknown } | null;
};

export type EnrichedMcpToolCallRow<T extends McpToolCallRow> = T & {
  agentName: string;
  serverDisplayName: string | null;
  toolDisplayName: string | null;
  argumentsText: string | null;
};

export function enrichMcpToolCallRows<T extends McpToolCallRow>({
  toolCalls,
  agents,
  serverNameToCatalogName,
}: {
  toolCalls: T[];
  agents: AgentNameSource[] | undefined;
  serverNameToCatalogName: Map<string, string>;
}): EnrichedMcpToolCallRow<T>[] {
  const agentNameById = new Map(
    (agents ?? []).map((agent) => [agent.id, agent.name]),
  );

  return toolCalls.map((row) => {
    const fullName = row.toolCall?.name;
    const toolDisplayName = fullName
      ? parseFullToolName(fullName).toolName || fullName
      : null;
    const rawServerName = row.mcpServerName ?? null;

    return {
      ...row,
      agentName:
        (row.agentId ? agentNameById.get(row.agentId) : undefined) ??
        (row.agentId === null ? "Deleted MCP Gateway" : "Unknown"),
      serverDisplayName: rawServerName
        ? (serverNameToCatalogName.get(rawServerName) ?? rawServerName)
        : null,
      toolDisplayName,
      argumentsText:
        row.toolCall?.arguments === undefined
          ? null
          : JSON.stringify(row.toolCall.arguments),
    };
  });
}
