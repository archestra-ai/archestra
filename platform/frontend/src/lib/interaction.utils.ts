import type { PartialUIMessage } from "@/components/chatbot-demo";
import type {
  GetInteractionResponse,
  GetInteractionsResponses,
} from "@/lib/clients/api";

/**
 * Check if the last message in an interaction is a tool message
 */
export function isLastMessageToolCall(
  interaction: GetInteractionsResponses["200"][number],
): boolean {
  const messages = interaction.request.messages;
  if (messages.length === 0) return false;
  const lastMessage = messages[messages.length - 1];
  return lastMessage.role === "tool";
}

/**
 * Get the tool_call_id from the last message if it's a tool message
 */
export function getLastToolCallId(
  interaction: GetInteractionsResponses["200"][number],
): string | null {
  const messages = interaction.request.messages;
  if (messages.length === 0) return null;
  const lastMessage = messages[messages.length - 1];
  if (lastMessage.role === "tool") {
    return lastMessage.tool_call_id;
  }
  return null;
}

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

export function mapInteractionToUiMessage(
  message:
    | GetInteractionResponse["request"]["messages"][number]
    | GetInteractionResponse["response"]["choices"][number]["message"],
): PartialUIMessage {
  const content = message.content;

  // Map content to UIMessage parts
  const parts: PartialUIMessage["parts"] = [];

  // Handle assistant messages with tool calls
  if (message.role === "assistant" && "tool_calls" in message) {
    const toolCalls = message.tool_calls;

    // Add text content if present
    if (typeof content === "string" && content) {
      parts.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text") {
          parts.push({ type: "text", text: part.text });
        } else if (part.type === "refusal") {
          parts.push({ type: "text", text: part.refusal });
        }
      }
    }

    // Add tool invocation parts
    if (toolCalls) {
      for (const toolCall of toolCalls) {
        if (toolCall.type === "function") {
          parts.push({
            type: "dynamic-tool",
            toolName: toolCall.function.name,
            toolCallId: toolCall.id,
            state: "input-available",
            input: JSON.parse(toolCall.function.arguments),
          });
        } else if (toolCall.type === "custom") {
          parts.push({
            type: "dynamic-tool",
            toolName: toolCall.custom.name,
            toolCallId: toolCall.id,
            state: "input-available",
            input: JSON.parse(toolCall.custom.input),
          });
        }
      }
    }
  }
  // Handle assistant messages with refusals (but no tool calls)
  else if (
    message.role === "assistant" &&
    "refusal" in message &&
    message.refusal
  ) {
    // Parse the refusal message to extract tool information
    const refusalInfo = parseRefusalMessage(message.refusal);

    // Check if this is a tool invocation policy block
    if (refusalInfo.toolName) {
      // Create a special blocked tool part
      parts.push({
        type: "blocked-tool",
        toolName: refusalInfo.toolName,
        toolArguments: refusalInfo.toolArguments,
        reason: refusalInfo.reason || "Tool invocation blocked by policy",
        fullRefusal: message.refusal,
      });
    } else {
      // Regular refusal text
      parts.push({ type: "text", text: message.refusal });
    }
  }
  // Handle tool response messages
  else if (message.role === "tool") {
    const toolContent = message.content;
    const toolCallId = message.tool_call_id;

    // Parse the tool output
    let output: unknown;
    try {
      output =
        typeof toolContent === "string" ? JSON.parse(toolContent) : toolContent;
    } catch {
      output = toolContent;
    }

    parts.push({
      type: "dynamic-tool",
      toolName: "tool-result",
      toolCallId,
      state: "output-available",
      input: {},
      output,
    });
  }
  // Handle regular content
  else {
    if (typeof content === "string") {
      parts.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text") {
          parts.push({ type: "text", text: part.text });
        } else if (part.type === "image_url") {
          parts.push({
            type: "file",
            mediaType: "image/*",
            url: part.image_url.url,
          });
        } else if (part.type === "refusal") {
          parts.push({ type: "text", text: part.refusal });
        }
        // Note: input_audio and file types from API would need additional handling
      }
    }
  }

  // Map role to UIMessage role (only system, user, assistant are allowed)
  let role: "system" | "user" | "assistant";
  if (message.role === "developer" || message.role === "system") {
    role = "system";
  } else if (message.role === "function" || message.role === "tool") {
    role = "assistant";
  } else {
    role = message.role;
  }

  return {
    role,
    parts,
  };
}
