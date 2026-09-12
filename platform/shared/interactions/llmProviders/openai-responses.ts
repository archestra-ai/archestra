import type { WithoutLockedChatUnavailable } from "../../locked-chat-content";
import { parseArchestraToolRefusal } from "../../tool-refusal";
import type { PartialUIMessage } from "../types";
import type { Interaction, InteractionUtils } from "./common";
import { tryParseJson } from "./json";

type OpenAiResponsesArm = Extract<
  Interaction,
  {
    type:
      | "azure:responses"
      | "github-copilot:responses"
      | "openai:responses"
      | "perplexity:responses";
  }
>;

// Failed interactions persist `{ error }` in place of a provider response;
// DynamicInteraction handles those before delegating here, so this mapper only
// ever sees a real provider response. The request side of the API type also
// carries a loose read-back arm (a drifted persisted row serializes raw
// instead of 500-ing the list) — narrow to the canonical request shape here;
// every access below is already defensive about the runtime payload.
type OpenAiResponsesInteractionRecord = Omit<
  OpenAiResponsesArm,
  "request" | "response"
> & {
  request: Extract<OpenAiResponsesArm["request"], { model: string }>;
  response: WithoutLockedChatUnavailable<
    Exclude<OpenAiResponsesArm["response"], { error: string }>
  >;
};

class OpenAiResponsesInteraction implements InteractionUtils {
  private interaction: OpenAiResponsesInteractionRecord;
  modelName: string;

  constructor(interaction: Interaction) {
    this.interaction = interaction as OpenAiResponsesInteractionRecord;
    this.modelName = interaction.model ?? this.interaction.request.model;
  }

  isLastMessageToolCall(): boolean {
    const items = this.getInputItems();
    const lastItem = items[items.length - 1];
    return isFunctionCallOutputItem(lastItem);
  }

  getLastToolCallId(): string | null {
    const items = this.getInputItems();
    const lastItem = items[items.length - 1];
    return isFunctionCallOutputItem(lastItem) ? lastItem.call_id : null;
  }

  getToolNamesUsed(): string[] {
    const requestedToolNamesByCallId = new Map(
      this.getOutputItems()
        .filter(isResponseFunctionCall)
        .map((item) => [item.call_id, item.name]),
    );

    return this.getInputItems()
      .filter(isFunctionCallOutputItem)
      .flatMap((item) => requestedToolNamesByCallId.get(item.call_id) ?? []);
  }

  getToolNamesRefused(): string[] {
    const toolNames = new Set<string>();

    for (const item of this.getOutputItems()) {
      if (!isResponseMessage(item)) {
        continue;
      }

      for (const part of getResponseMessageParts(item.content)) {
        if (!isResponseRefusalPart(part)) {
          continue;
        }

        const toolName = parseArchestraToolRefusal(part.refusal).toolName;
        if (toolName) {
          toolNames.add(toolName);
        }
      }
    }

    return Array.from(toolNames);
  }

  getToolNamesRequested(): string[] {
    return this.getOutputItems()
      .filter(isResponseFunctionCall)
      .map((item) => item.name);
  }

  getToolRefusedCount(): number {
    return this.getToolNamesRefused().length;
  }

  getLastUserMessage(): string {
    for (const item of [...this.getInputItems()].reverse()) {
      if (isRequestMessage(item) && item.role === "user") {
        return extractInputMessageText(item.content);
      }
    }

    return "";
  }

  getLastAssistantResponse(): string {
    const assistantMessage = this.getOutputItems().find(isResponseMessage);

    if (!assistantMessage) {
      return "";
    }

    return extractResponseMessageText(assistantMessage.content);
  }

  mapToUiMessages(): PartialUIMessage[] {
    const messages: PartialUIMessage[] = [];

    for (const item of this.getInputItems()) {
      if (!isRequestMessage(item)) {
        continue;
      }

      messages.push({
        role: responsesRoleToUiMessageRole(item.role),
        parts: [{ type: "text", text: extractInputMessageText(item.content) }],
      });
    }

    for (const item of this.getOutputItems()) {
      if (isResponseMessage(item)) {
        const text = extractResponseMessageText(item.content);

        messages.push({
          role: "assistant",
          parts: [{ type: "text", text }],
        });
      }

      if (isResponseFunctionCall(item)) {
        messages.push({
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: item.name,
              toolCallId: item.call_id,
              state: "input-available",
              input: tryParseJson(item.arguments),
            },
          ],
        });
      }
    }

    return messages;
  }

  private getInputItems(): unknown[] {
    return Array.isArray(this.interaction.request.input)
      ? this.interaction.request.input
      : [];
  }

  private getOutputItems(): unknown[] {
    const output = this.interaction.response.output;
    return Array.isArray(output) ? output : [];
  }
}

export default OpenAiResponsesInteraction;

// `type` is optional on Responses input messages — it defaults to "message" —
// and the AI SDK omits it, serializing plain turns as bare `{role, content}`.
// Requiring the tag dropped every SDK-sent message on the floor, so the logs
// rendered "No message" with an empty conversation. Key off `role` instead and
// only reject items that tag themselves as something else (function_call,
// function_call_output, reasoning).
function isRequestMessage(
  item: unknown,
): item is { type?: "message"; role: string; content: unknown } {
  if (!item || typeof item !== "object" || !("role" in item)) {
    return false;
  }
  const type = (item as { type?: unknown }).type;
  return type === undefined || type === "message";
}

// Mirrors the chat-completions mapper: instruction turns render as the "System
// Prompt" block rather than as a user message.
function responsesRoleToUiMessageRole(role: string): PartialUIMessage["role"] {
  if (role === "assistant") {
    return "assistant";
  }
  if (role === "system" || role === "developer") {
    return "system";
  }
  return "user";
}

function isFunctionCallOutputItem(
  item: unknown,
): item is { type: "function_call_output"; call_id: string } {
  return (
    !!item &&
    typeof item === "object" &&
    "type" in item &&
    item.type === "function_call_output" &&
    "call_id" in item &&
    typeof item.call_id === "string"
  );
}

function isResponseMessage(
  item: unknown,
): item is { type: "message"; content: unknown } {
  return (
    !!item &&
    typeof item === "object" &&
    "type" in item &&
    item.type === "message" &&
    "content" in item
  );
}

function isResponseFunctionCall(item: unknown): item is {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
} {
  return (
    !!item &&
    typeof item === "object" &&
    "type" in item &&
    item.type === "function_call" &&
    "call_id" in item &&
    typeof item.call_id === "string" &&
    "name" in item &&
    typeof item.name === "string" &&
    "arguments" in item &&
    typeof item.arguments === "string"
  );
}

function getResponseMessageParts(content: unknown): unknown[] {
  return Array.isArray(content) ? content : [];
}

function extractResponseMessageText(content: unknown): string {
  return getResponseMessageParts(content)
    .flatMap((part) => {
      if (isResponseOutputTextPart(part)) {
        return [part.text];
      }

      if (isResponseRefusalPart(part)) {
        return [part.refusal];
      }

      return [];
    })
    .join("\n");
}

function isResponseOutputTextPart(
  part: unknown,
): part is { type: "output_text"; text: string } {
  return (
    !!part &&
    typeof part === "object" &&
    "type" in part &&
    part.type === "output_text" &&
    "text" in part &&
    typeof part.text === "string"
  );
}

function isResponseRefusalPart(
  part: unknown,
): part is { type: "refusal"; refusal: string } {
  return (
    !!part &&
    typeof part === "object" &&
    "type" in part &&
    part.type === "refusal" &&
    "refusal" in part &&
    typeof part.refusal === "string"
  );
}

function extractInputMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || !("type" in part)) {
        return [];
      }

      if (part.type === "input_text" && "text" in part) {
        return typeof part.text === "string" ? [part.text] : [];
      }

      if (part.type === "output_text" && "text" in part) {
        return typeof part.text === "string" ? [part.text] : [];
      }

      return [];
    })
    .join("\n");
}
