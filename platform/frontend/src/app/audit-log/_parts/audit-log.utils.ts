import { DynamicInteraction, parseFullToolName } from "@shared";
import { formatAuthMethod } from "@/lib/mcp/mcp-tool-call.query";
import type {
  AuditEventStatus,
  AuditEventTypeFilter,
  AuditLogEvent,
  LlmInteraction,
  McpToolCall,
} from "./audit-log.types";

export function getValidTypeFilter(value: string | null): AuditEventTypeFilter {
  if (value === "LLM" || value === "MCP") {
    return value;
  }
  return "all";
}

function getDynamicInteraction(interaction: LlmInteraction) {
  try {
    return new DynamicInteraction(interaction);
  } catch {
    return null;
  }
}

export function getLlmAuditEvent(interaction: LlmInteraction): AuditLogEvent {
  const dynamicInteraction = getDynamicInteraction(interaction);
  const blockedTools = dynamicInteraction?.getToolNamesRefused() ?? [];
  const lastUserMessage = dynamicInteraction?.getLastUserMessage();
  const [provider, endpoint] = interaction.type.split(":");
  const model = interaction.model ?? dynamicInteraction?.modelName;
  const externalAgentIdLabel =
    "externalAgentIdLabel" in interaction
      ? interaction.externalAgentIdLabel
      : null;
  const actor =
    externalAgentIdLabel ??
    interaction.userId ??
    interaction.externalAgentId ??
    interaction.source ??
    "Unknown";
  const status: AuditEventStatus =
    blockedTools.length > 0 ||
    interaction.unsafeContextBoundary?.reason === "tool_result_blocked"
      ? "Denied"
      : "Allowed";

  return {
    id: `llm:${interaction.id}`,
    href: `/llm/logs/${interaction.id}`,
    createdAt: interaction.createdAt,
    type: "LLM",
    actor,
    action: `${provider ?? "llm"}.${endpoint ?? "request"}`,
    target: model ?? "Unknown model",
    from: interaction.source ?? interaction.sessionSource ?? "API",
    status,
    summary:
      blockedTools.length > 0
        ? `Blocked tools: ${blockedTools.join(", ")}`
        : lastUserMessage || `Processed ${model ?? "LLM"} request`,
  };
}

export function isMcpToolCallFailed(toolCall: McpToolCall) {
  if (toolCall.method !== "tools/call") {
    return false;
  }

  const result = toolCall.toolResult;
  return (
    result !== null &&
    typeof result === "object" &&
    "isError" in result &&
    Boolean((result as { isError?: unknown }).isError)
  );
}

export function getMcpTarget(toolCall: McpToolCall) {
  const rawToolName = toolCall.toolCall?.name;
  if (!rawToolName) {
    return toolCall.mcpServerName;
  }

  const { toolName } = parseFullToolName(rawToolName);
  return toolName || rawToolName;
}

export function getMcpAuditEvent(toolCall: McpToolCall): AuditLogEvent {
  const target = getMcpTarget(toolCall);
  const actor =
    toolCall.userName ??
    toolCall.userId ??
    formatAuthMethod(toolCall.authMethod) ??
    "Unknown";
  const failed = isMcpToolCallFailed(toolCall);

  return {
    id: `mcp:${toolCall.id}`,
    href: `/mcp/logs/${toolCall.id}`,
    createdAt: toolCall.createdAt,
    type: "MCP",
    actor,
    action: toolCall.method || "tools/call",
    target,
    from: formatAuthMethod(toolCall.authMethod),
    status: failed ? "Failed" : "Allowed",
    summary: toolCall.toolCall
      ? `Called ${target} on ${toolCall.mcpServerName}`
      : `${toolCall.method} on ${toolCall.mcpServerName}`,
  };
}

export function buildAuditLogEvents({
  interactions,
  mcpToolCalls,
  typeFilter,
}: {
  interactions: LlmInteraction[];
  mcpToolCalls: McpToolCall[];
  typeFilter: AuditEventTypeFilter;
}) {
  const llmEvents =
    typeFilter === "MCP" ? [] : interactions.map(getLlmAuditEvent);
  const mcpEvents =
    typeFilter === "LLM" ? [] : mcpToolCalls.map(getMcpAuditEvent);

  return [...llmEvents, ...mcpEvents].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

export function filterAuditLogEvents({
  events,
  searchQuery,
}: {
  events: AuditLogEvent[];
  searchQuery: string;
}) {
  const normalizedSearch = searchQuery.trim().toLowerCase();
  if (!normalizedSearch) {
    return events;
  }

  return events.filter((event) =>
    [
      event.actor,
      event.action,
      event.target,
      event.from,
      event.status,
      event.summary,
      event.type,
    ].some((value) => value.toLowerCase().includes(normalizedSearch)),
  );
}

export function getAuditLogSummary(events: AuditLogEvent[]) {
  const allowedCount = events.filter(
    (event) => event.status === "Allowed",
  ).length;

  return {
    totalCount: events.length,
    allowedCount,
    blockedOrFailedCount: events.length - allowedCount,
  };
}
