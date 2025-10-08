import type { GetChatsResponses } from "@shared/api-client";

export function toolNamesUsedForChat(chat: GetChatsResponses["200"][number]) {
  const toolsUsed = new Set<string>();
  const interactions = chat.interactions;
  for (const interaction of interactions) {
    const { content } = interaction;
    if (content.role === "assistant" && content.tool_calls) {
      for (const toolCall of content.tool_calls) {
        if ("function" in toolCall) {
          toolsUsed.add(toolCall.function.name);
        }
      }
    }
  }
  return Array.from(toolsUsed);
}

export function toolNamesRefusedForChat(
  chat: GetChatsResponses["200"][number],
) {
  const toolsRefused = new Set<string>();
  const interactions = chat.interactions;
  for (const interaction of interactions) {
    const { content } = interaction;
    if (content.role === "assistant") {
      if (content.refusal && content.refusal.length > 0) {
        const toolName = content.refusal.match(
          /<archestra-tool-name>(.*?)<\/archestra-tool-name>/,
        )?.[1];
        if (toolName) {
          toolsRefused.add(toolName);
        }
      }
    }
  }
  return Array.from(toolsRefused);
}
