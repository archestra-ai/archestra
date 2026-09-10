import type { UIMessage } from "@ai-sdk/react";
import type { AgentRunReadableTranscript } from "@archestra/shared";
import type { DynamicToolUIPart } from "ai";

/** Adapt provider events to the same message renderer used by ordinary chat. */
export function runtimeChatMessages(
  transcript: AgentRunReadableTranscript,
): UIMessage[] {
  const messages: UIMessage[] = [];
  const tools = new Map<string, DynamicToolUIPart>();
  for (const [index, entry] of transcript.entries.entries()) {
    const id = entry.id ?? `entry-${index}`;
    if (entry.type === "message" && entry.role === "user") {
      messages.push({
        id,
        role: "user",
        parts: [{ type: "text", text: entry.text }],
      });
      continue;
    }
    let message = messages.at(-1);
    if (!message || message.role !== "assistant") {
      message = { id, role: "assistant", parts: [] };
      messages.push(message);
    }
    if (entry.type === "message") {
      message.parts.push({ type: "text", text: entry.text });
    } else if (entry.type === "tool_call") {
      let input: unknown = entry.input;
      try {
        input = JSON.parse(entry.input ?? "{}");
      } catch {
        /* Preserve non-JSON tool input. */
      }
      const part: DynamicToolUIPart = {
        type: "dynamic-tool",
        toolName: entry.name,
        toolCallId: entry.toolCallId ?? id,
        state: "input-available",
        input,
      };
      tools.set(part.toolCallId, part);
      message.parts.push(part);
    } else {
      const part = entry.toolCallId ? tools.get(entry.toolCallId) : undefined;
      if (part) {
        if (entry.isError)
          Object.assign(part, { state: "output-error", errorText: entry.text });
        else
          Object.assign(part, {
            state: "output-available",
            output: entry.text,
          });
      } else {
        message.parts.push({ type: "text", text: entry.text });
      }
    }
  }
  return messages;
}
