import type { UIMessage } from "ai";

/**
 * Ordered, de-duplicated top-level tool names from an agent's response
 * message. Mirrors the tool-part shape used across the platform: static tools
 * appear as `tool-<name>` parts, MCP tools as `dynamic-tool` parts carrying
 * `toolName`. One entry per toolCallId; nested (delegated subagent) calls are
 * not present in the top-level message and are deliberately out of scope for
 * alpha trajectory assertions.
 */
export function extractTopLevelToolNames(message: UIMessage): string[] {
  const byCallId = new Map<string, string>();
  for (const rawPart of message.parts ?? []) {
    const part = rawPart as {
      type?: unknown;
      toolCallId?: unknown;
      toolName?: unknown;
    };
    const type = part.type;
    if (typeof type !== "string") continue;
    const isToolPart = type.startsWith("tool-") || type === "dynamic-tool";
    if (!isToolPart || typeof part.toolCallId !== "string") continue;
    const toolName =
      type === "dynamic-tool"
        ? typeof part.toolName === "string"
          ? part.toolName
          : "unknown"
        : type.slice("tool-".length);
    byCallId.set(part.toolCallId, toolName);
  }
  return [...byCallId.values()];
}
