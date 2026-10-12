import type { ChatMessage } from "@/types";

// UTF-8 bytes, the unit OpenAPPA measures a result body in: its 64 KiB host
// default `max_body_bytes` (archestra-rs/openappa-rs/src/policy.rs) drops a
// longer result outright. ~16k tokens, still ample for legitimate large outputs.
export const MAX_TOOL_RESULT_CONTEXT_BYTES = 65_536;

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The longest prefix of `text` within `maxBytes`, never splitting a character. */
export function sliceUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  // Back off continuation bytes (10xxxxxx) to a character boundary.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

export interface CappedToolResult {
  totalChars: number;
  /** Sandbox path holding the full result; absent when it could not be stored. */
  path?: string;
}

/**
 * Bounds a tool result's model-facing text to {@link MAX_TOOL_RESULT_CONTEXT_BYTES}.
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
  const keptSuffix = sliceUtf8(
    suffix,
    MAX_TOOL_RESULT_CONTEXT_BYTES - utf8Length(notice),
  );
  const headBudget =
    MAX_TOOL_RESULT_CONTEXT_BYTES - utf8Length(notice) - utf8Length(keptSuffix);
  return `${notice}${sliceUtf8(text, headBudget)}${keptSuffix}`;
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
