import { parseArchestraToolRefusal } from "../../tool-refusal";
import type { PartialUIMessage } from "../types";
import type { Interaction, InteractionUtils } from "./common";

type OpenAiResponsesInteractionRecord = Extract<
  Interaction,
  { type: "azure:responses" | "openai:responses" }
>;

type OpenAiResponsesOutputItem =
  OpenAiResponsesInteractionRecord["response"]["output"][number];

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
      this.interaction.response.output
        .filter(isResponseFunctionCall)
        .map((item) => [item.call_id, item.name]),
    );

    return this.getInputItems()
      .filter(isFunctionCallOutputItem)
      .flatMap((item) => requestedToolNamesByCallId.get(item.call_id) ?? []);
  }

  getToolNamesRefused(): string[] {
    const toolNames = new Set<string>();

    for (const item of this.interaction.response.output) {
      if (!isResponseMessage(item)) {
        continue;
      }

      for (const part of item.content) {
        if (part.type !== "refusal") {
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
    return this.interaction.response.output
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
    const assistantMessage =
      this.interaction.response.output.find(isResponseMessage);

    if (!assistantMessage) {
      return "";
    }

    return assistantMessage.content
      .flatMap((part) => {
        if (part.type === "output_text") {
          return [part.text];
        }

        if (part.type === "refusal") {
          return [part.refusal];
        }

        return [];
      })
      .join("\n");
  }

  mapToUiMessages(): PartialUIMessage[] {
    const messages: PartialUIMessage[] = [];

    for (const item of this.getInputItems()) {
      if (!isRequestMessage(item)) {
        continue;
      }

      messages.push({
        role: item.role === "assistant" ? "assistant" : "user",
        parts: [{ type: "text", text: extractInputMessageText(item.content) }],
      });
    }

    for (const item of this.interaction.response.output) {
      if (isResponseMessage(item)) {
        const text = item.content
          .flatMap((part) => {
            if (part.type === "output_text") {
              return [part.text];
            }

            if (part.type === "refusal") {
              return [part.refusal];
            }

            return [];
          })
          .join("\n");

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
}

export default OpenAiResponsesInteraction;

function isRequestMessage(
  item: unknown,
): item is { type: "message"; role: "user" | "assistant"; content: unknown } {
  return (
    !!item &&
    typeof item === "object" &&
    "type" in item &&
    item.type === "message"
  );
}

function isFunctionCallOutputItem(
  item: unknown,
): item is { type: "function_call_output"; call_id: string } {
  return (
    !!item &&
    typeof item === "object" &&
    "type" in item &&
    item.type === "function_call_output"
  );
}

function isResponseMessage(
  item: OpenAiResponsesOutputItem,
): item is Extract<OpenAiResponsesOutputItem, { type: "message" }> {
  return item.type === "message";
}

function isResponseFunctionCall(
  item: OpenAiResponsesOutputItem,
): item is Extract<OpenAiResponsesOutputItem, { type: "function_call" }> {
  return item.type === "function_call";
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

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
