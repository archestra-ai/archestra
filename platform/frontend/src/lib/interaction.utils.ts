import type { GetInteractionsResponses } from "@shared/api-client";

export function toolNamesUsedForInteraction(
  interaction: GetInteractionsResponses["200"][number],
) {
  const toolsUsed = new Set<string>();
  for (const message of interaction.request.messages) {
    if (message.role === "assistant" && message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if ("function" in toolCall) {
          toolsUsed.add(toolCall.function.name);
        }
      }
    }
  }
  return Array.from(toolsUsed);
}

export function toolNamesRefusedForInteraction(
  interaction: GetInteractionsResponses["200"][number],
) {
  const toolsRefused = new Set<string>();
  for (const message of interaction.request.messages) {
    if (message.role === "assistant") {
      if (message.refusal && message.refusal.length > 0) {
        const toolName = message.refusal.match(
          /<archestra-tool-name>(.*?)<\/archestra-tool-name>/,
        )?.[1];
        if (toolName) {
          toolsRefused.add(toolName);
        }
      }
    }
  }
  for (const message of interaction.response.choices) {
    if (message.message.refusal && message.message.refusal.length > 0) {
      const toolName = message.message.refusal.match(
        /<archestra-tool-name>(.*?)<\/archestra-tool-name>/,
      )?.[1];
      if (toolName) {
        toolsRefused.add(toolName);
      }
    }
  }
  return Array.from(toolsRefused);
}

export function toolsRefusedCountForInteraction(
  interaction: GetInteractionsResponses["200"][number],
) {
  let count = 0;
  for (const message of interaction.request.messages) {
    if (message.role === "assistant") {
      if (message.refusal && message.refusal.length > 0) {
        count++;
      }
    }
  }
  for (const message of interaction.response.choices) {
    if (message.message.refusal && message.message.refusal.length > 0) {
      count++;
    }
  }
  return count;
}

export interface RefusalInfo {
  toolName?: string;
  toolArguments?: string;
  reason?: string;
}

export function parseRefusalMessage(refusal: string): RefusalInfo {
  const toolNameMatch = refusal.match(
    /<archestra-tool-name>(.*?)<\/archestra-tool-name>/,
  );
  const toolArgsMatch = refusal.match(
    /<archestra-tool-arguments>(.*?)<\/archestra-tool-arguments>/,
  );
  const toolReasonMatch = refusal.match(
    /<archestra-tool-reason>(.*?)<\/archestra-tool-reason>/,
  );

  return {
    toolName: toolNameMatch?.[1],
    toolArguments: toolArgsMatch?.[1],
    reason: toolReasonMatch?.[1] || "Blocked by policy",
  };
}
