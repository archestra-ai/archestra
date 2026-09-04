import {
  type AgentRunReadableTranscriptEntry,
  AgentRunReadableTranscriptSchema,
} from "@archestra/shared";

export function formatAgentRunReadableTranscript(value: string): string | null {
  const parsed = AgentRunReadableTranscriptSchema.safeParse(parseJson(value));
  if (!parsed.success) return null;

  const toolNames = new Map<string, string>();
  const sections = parsed.data.entries.map((entry) => {
    if (entry.type === "tool_call" && entry.toolCallId) {
      toolNames.set(entry.toolCallId, entry.name);
    }
    return formatEntry(entry, toolNames);
  });
  return sections.join("\n\n");
}

function formatEntry(
  entry: AgentRunReadableTranscriptEntry,
  toolNames: Map<string, string>,
): string {
  const timestamp = entry.timestamp
    ? ` · ${formatTimestamp(entry.timestamp)}`
    : "";
  if (entry.type === "message") {
    const role = entry.role === "user" ? "User" : "Assistant";
    return `${role}${timestamp}\n${entry.text}`;
  }
  if (entry.type === "tool_call") {
    return entry.input
      ? `Tool · ${entry.name}${timestamp}\nArguments\n${formatJson(entry.input)}`
      : `Tool · ${entry.name}${timestamp}`;
  }

  const toolName = entry.toolCallId
    ? toolNames.get(entry.toolCallId)
    : undefined;
  const label = entry.isError ? "Tool error" : "Tool result";
  return `${label}${toolName ? ` · ${toolName}` : ""}${timestamp}\n${entry.text}`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
