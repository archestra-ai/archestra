import type { ChatMessage } from "@/types";

// ~25k tokens at typical densities — generous enough for legitimate large
// outputs (file reads, API listings) while keeping a single result from
// consuming a meaningful fraction of the context window.
export const MAX_TOOL_RESULT_CONTEXT_CHARS = 100_000;

export interface CappedToolResult {
  totalChars: number;
  /** Sandbox path holding the full result; absent when it could not be stored. */
  path?: string;
}

/**
 * Bounds a tool result's model-facing text to {@link MAX_TOOL_RESULT_CONTEXT_CHARS}.
 * The notice leads so it survives any later prefix slice; `suffix` (hook
 * feedback) trails and is always kept.
 */
export function capToolResultText(params: {
  text: string;
  path: string | null;
  suffix: string;
}): string {
  const { text, path, suffix } = params;
  const notice = path
    ? `[Tool result too large: ${text.length} chars. The full result is saved in the sandbox at ${path} — inspect it with run_command (e.g. grep -n, sed -n 'START,ENDp', jq). Beginning of the result:]\n\n`
    : `[Tool result too large: ${text.length} chars. Only the beginning is shown:]\n\n`;
  const keptSuffix = suffix.slice(
    0,
    MAX_TOOL_RESULT_CONTEXT_CHARS - notice.length,
  );
  const headBudget =
    MAX_TOOL_RESULT_CONTEXT_CHARS - notice.length - keptSuffix.length;
  return `${notice}${text.slice(0, headBudget)}${keptSuffix}`;
}

/** Marker `_meta` key on a rich tool result whose `content` was capped. */
export const CAPPED_TOOL_RESULT_META_KEY = "archestra/cappedToolResult";

export function readCappedToolResult(output: unknown): CappedToolResult | null {
  if (!isRecord(output) || !isRecord(output._meta)) return null;
  const marker = output._meta[CAPPED_TOOL_RESULT_META_KEY];
  if (!isRecord(marker) || typeof marker.totalChars !== "number") return null;
  return {
    totalChars: marker.totalChars,
    ...(typeof marker.path === "string" ? { path: marker.path } : {}),
  };
}

/**
 * History replay converts tool outputs without their tools, so a rich output
 * would be sent whole — including the uncapped `structuredContent` /
 * `rawContent` kept for the UI. Capped outputs are replayed as their capped
 * `content` text instead, matching what the model saw live.
 */
export function projectCappedToolOutputs(
  messages: ChatMessage[],
): ChatMessage[] {
  let changed = false;
  const projected = messages.map((message) => {
    if (!message.parts) return message;
    let messageChanged = false;
    const parts = message.parts.map((part) => {
      const isToolPart =
        part.type === "dynamic-tool" || part.type.startsWith("tool-");
      const output = part.output;
      if (
        !isToolPart ||
        !readCappedToolResult(output) ||
        !isRecord(output) ||
        typeof output.content !== "string"
      ) {
        return part;
      }
      messageChanged = true;
      return { ...part, output: output.content };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, parts };
  });
  return changed ? projected : messages;
}

// === Internal helpers ===

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
