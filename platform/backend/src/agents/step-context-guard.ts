/**
 * Per-step context guard for the agentic loop (wired via the AI SDK's
 * `prepareStep` hook, which lets each step override the messages sent to the
 * model without touching the loop's own accumulated state).
 *
 * Tool results enter the loop's history uncapped — a single oversized result
 * (e.g. a raw workflow-runs listing) can blow past the model's context window
 * mid-turn. Before each step, cap oversized tool-result outputs and, when the
 * model's context window is known, proactively trim the step's messages to fit
 * instead of waiting for the provider to reject the request.
 */
import type { ModelMessage } from "ai";
import { trimMessagesToTokenLimit } from "@/routes/chat/context-trimming";

export function guardStepMessages(params: {
  messages: ModelMessage[];
  contextLength: number | null;
  systemPrompt?: string;
}): ModelMessage[] {
  const { messages, contextLength, systemPrompt } = params;
  const capped = capOversizedToolResults(messages);
  if (!contextLength) return capped;
  return trimMessagesToTokenLimit({
    messages: capped,
    maxTokens: Math.floor(contextLength * CONTEXT_WINDOW_BUDGET_RATIO),
    systemPrompt,
  });
}

// =============================================================================
// INTERNAL
// =============================================================================

/**
 * Replace tool-result outputs whose serialized size exceeds the cap with a
 * truncated text rendering plus a notice. The replacement happens in place on
 * the tool message (same toolCallId), so tool-call/tool-result pairing stays
 * intact for provider validation.
 */
function capOversizedToolResults(messages: ModelMessage[]): ModelMessage[] {
  let changed = false;
  const result = messages.map((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      return message;
    }
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") return part;
      const serialized = JSON.stringify(part.output);
      if (serialized.length <= MAX_TOOL_RESULT_CONTEXT_CHARS) return part;
      messageChanged = true;
      return {
        ...part,
        output: {
          type: "text" as const,
          value: `${serialized.slice(0, MAX_TOOL_RESULT_CONTEXT_CHARS)}\n[tool result truncated: ${serialized.length} chars exceeded the ${MAX_TOOL_RESULT_CONTEXT_CHARS}-char limit for model context]`,
        },
      };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content } as ModelMessage;
  });
  return changed ? result : messages;
}

// ~25k tokens at typical densities — generous enough for legitimate large
// outputs (file reads, API listings) while keeping a single result from
// consuming a meaningful fraction of the context window.
const MAX_TOOL_RESULT_CONTEXT_CHARS = 100_000;

// Mirrors the /chat auto-compaction threshold (CONTEXT_COMPACTION_AUTO_THRESHOLD):
// leave 20% of the window for the system prompt estimate error and the response.
const CONTEXT_WINDOW_BUDGET_RATIO = 0.8;
