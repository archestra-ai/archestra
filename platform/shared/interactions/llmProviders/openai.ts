import { type archestraApiTypes, parseArchestraToolRefusal } from "../../index";
import type { PartialUIMessage } from "../types";
import type { DualLlmAnalysis, Interaction, InteractionUtils } from "./common";

type RequestMessage =
  archestraApiTypes.OpenAiChatCompletionRequest["messages"][number];
type ResponseChoice =
  archestraApiTypes.OpenAiChatCompletionResponse["choices"][number];

// Responses API item shapes (runtime only — these requests share the
// "openai:chatCompletions" interaction type but carry input/output instead
// of messages/choices).
type ResponsesInputItem =
  | { type: "message"; role: string; content: unknown }
  | {
      type: "function_call";
      id?: string;
      call_id: string;
      name: string;
      arguments: string;
    }
  | { type: "function_call_output"; call_id: string; output: string };

type ResponsesOutputTextPart = { type: "output_text"; text: string };
type ResponsesOutputRefusalPart = { type: "refusal"; refusal: string };
type ResponsesOutputItem =
  | {
      type: "message";
      id: string;
      role: "assistant";
      content: Array<ResponsesOutputTextPart | ResponsesOutputRefusalPart>;
    }
  | {
      type: "function_call";
      id: string;
      call_id: string;
      name: string;
      arguments: string;
      status?: string;
    };

class OpenAiChatCompletionInteraction implements InteractionUtils {
  private request: archestraApiTypes.OpenAiChatCompletionRequest;
  private response: archestraApiTypes.OpenAiChatCompletionResponse;
  modelName: string;

  constructor(interaction: Interaction) {
    this.request =
      interaction.request as archestraApiTypes.OpenAiChatCompletionRequest;
    this.response =
      interaction.response as archestraApiTypes.OpenAiChatCompletionResponse;
    this.modelName = interaction.model ?? this.request.model;
  }

  isLastMessageToolCall(): boolean {
    if (this.isResponsesApi()) {
      const input = this.responsesInput();
      if (input.length === 0) return false;
      return input[input.length - 1].type === "function_call_output";
    }
    const messages = this.requestMessages;
    if (messages.length === 0) return false;
    return messages[messages.length - 1].role === "tool";
  }

  getLastToolCallId(): string | null {
    if (this.isResponsesApi()) {
      const input = this.responsesInput();
      const last = input[input.length - 1];
      if (last?.type === "function_call_output") return last.call_id;
      return null;
    }
    const messages = this.requestMessages;
    if (messages.length === 0) return null;
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role === "tool") return lastMessage.tool_call_id;
    return null;
  }

  getToolNamesUsed(): string[] {
    const toolsUsed = new Set<string>();
    if (this.isResponsesApi()) {
      for (const item of this.responsesInput()) {
        if (item.type === "function_call") {
          toolsUsed.add(item.name);
        }
      }
      return Array.from(toolsUsed);
    }
    for (const message of this.requestMessages) {
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

  getToolNamesRefused(): string[] {
    const toolsRefused = new Set<string>();
    if (this.isResponsesApi()) {
      for (const item of this.responsesOutput()) {
        if (item.type === "message") {
          for (const part of item.content) {
            if (part.type === "refusal") {
              const toolName = parseArchestraToolRefusal(part.refusal).toolName;
              if (toolName) toolsRefused.add(toolName);
            }
          }
        }
      }
      return Array.from(toolsRefused);
    }
    for (const message of this.requestMessages) {
      if (message.role === "assistant") {
        const refusal = message.refusal;
        if (refusal && refusal.length > 0) {
          const toolName = parseArchestraToolRefusal(refusal).toolName;
          if (toolName) toolsRefused.add(toolName);
        }
      }
    }
    for (const message of this.responseChoices) {
      const refusal = message.message.refusal;
      if (refusal && refusal.length > 0) {
        const toolName = parseArchestraToolRefusal(refusal).toolName;
        if (toolName) toolsRefused.add(toolName);
      }
    }
    return Array.from(toolsRefused);
  }

  getToolNamesRequested(): string[] {
    const toolsRequested = new Set<string>();
    if (this.isResponsesApi()) {
      for (const item of this.responsesOutput()) {
        if (item.type === "function_call") {
          toolsRequested.add(item.name);
        }
      }
      return Array.from(toolsRequested);
    }
    for (const choice of this.responseChoices) {
      if (Array.isArray(choice.message.tool_calls)) {
        for (const toolCall of choice.message.tool_calls) {
          if ("function" in toolCall) {
            toolsRequested.add(toolCall.function.name);
          }
        }
      }
    }
    return Array.from(toolsRequested);
  }

  getLastUserMessage(): string {
    if (this.isResponsesApi()) {
      const raw = (this.request as unknown as Record<string, unknown>).input;
      if (typeof raw === "string") return raw;
      const input = this.responsesInput();
      for (let i = input.length - 1; i >= 0; i--) {
        const item = input[i];
        if (item.type === "message" && item.role === "user") {
          return extractResponsesInputText(item.content);
        }
      }
      return "";
    }
    const reversedMessages = [...this.requestMessages].reverse();
    for (const message of reversedMessages) {
      if (message.role !== "user") continue;
      if (typeof message.content === "string") return message.content;
      if (message.content?.[0]?.type === "text") return message.content[0].text;
    }
    return "";
  }

  getLastAssistantResponse(): string {
    if (this.isResponsesApi()) {
      for (let i = this.responsesOutput().length - 1; i >= 0; i--) {
        const item = this.responsesOutput()[i];
        if (item.type === "message") {
          for (const part of item.content) {
            if (part.type === "output_text") return part.text;
          }
        }
      }
      return "";
    }
    return this.responseChoices[0]?.message?.content ?? "";
  }

  getToolRefusedCount(): number {
    let count = 0;
    if (this.isResponsesApi()) {
      for (const item of this.responsesOutput()) {
        if (item.type === "message") {
          for (const part of item.content) {
            if (part.type === "refusal") count++;
          }
        }
      }
      return count;
    }
    for (const message of this.requestMessages) {
      if (message.role === "assistant") {
        const refusal = message.refusal;
        if (refusal && refusal.length > 0) count++;
      }
    }
    for (const message of this.responseChoices) {
      const refusal = message.message.refusal;
      if (refusal && refusal.length > 0) count++;
    }
    return count;
  }

  mapToUiMessages(dualLlmAnalyses?: DualLlmAnalysis[]): PartialUIMessage[] {
    if (this.isResponsesApi()) {
      return [
        ...this.mapResponsesInputToUiMessages(dualLlmAnalyses),
        ...this.mapResponsesOutputToUiMessages(),
      ];
    }
    return [
      ...this.mapRequestToUiMessages(dualLlmAnalyses),
      ...this.mapResponseToUiMessages(),
    ];
  }

  // ==========================================================================
  // PRIVATE — Chat Completions rendering
  // ==========================================================================

  private mapToUiMessage(
    message:
      | RequestMessage
      | archestraApiTypes.OpenAiChatCompletionResponse["choices"][number]["message"],
  ): PartialUIMessage {
    const parts: PartialUIMessage["parts"] = [];
    const { content, role } = message;

    if (role === "assistant") {
      const { tool_calls: toolCalls } = message;
      const refusal = message.refusal;

      if (Array.isArray(toolCalls)) {
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
      } else if (refusal) {
        parts.push({ type: "text", text: refusal });
      } else {
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
      }
    } else if (message.role === "tool") {
      const toolContent = message.content;
      const toolCallId = message.tool_call_id;

      let resolvedToolName = "tool-result";
      for (const m of this.requestMessages) {
        if ("tool_calls" in m && Array.isArray(m.tool_calls)) {
          const tc = m.tool_calls.find((t) => t.id === toolCallId);
          if (tc) {
            resolvedToolName =
              tc.type === "function"
                ? tc.function.name
                : tc.type === "custom"
                  ? tc.custom.name
                  : "tool-result";
            break;
          }
        }
      }

      let output: unknown;
      try {
        output =
          typeof toolContent === "string"
            ? JSON.parse(toolContent)
            : toolContent;
      } catch {
        output = toolContent;
      }

      parts.push({
        type: "dynamic-tool",
        toolName: resolvedToolName,
        toolCallId,
        state: "output-available",
        input: {},
        output,
      });
    } else {
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
          }
        }
      }
    }

    const openAiRoleToUIMessageRoleMap: Record<
      archestraApiTypes.OpenAiChatCompletionRequest["messages"][number]["role"],
      PartialUIMessage["role"]
    > = {
      developer: "system",
      system: "system",
      function: "assistant",
      tool: "assistant",
      user: "user",
      assistant: "assistant",
    };

    return {
      role: openAiRoleToUIMessageRoleMap[role],
      parts,
    };
  }

  private mapRequestToUiMessages(
    dualLlmAnalyses?: DualLlmAnalysis[],
  ): PartialUIMessage[] {
    const messages = this.requestMessages;
    const uiMessages: PartialUIMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "tool") continue;

      const uiMessage = this.mapToUiMessage(msg);

      if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
        const toolCallParts: PartialUIMessage["parts"] = [...uiMessage.parts];

        for (const toolCall of msg.tool_calls) {
          const toolResultMsg = messages
            .slice(i + 1)
            .find(
              (m) =>
                m.role === "tool" &&
                "tool_call_id" in m &&
                m.tool_call_id === toolCall.id,
            );

          if (toolResultMsg && toolResultMsg.role === "tool") {
            const toolResultUiMsg = this.mapToUiMessage(toolResultMsg);
            toolCallParts.push(...toolResultUiMsg.parts);

            const dualLlmResultForTool = dualLlmAnalyses?.find(
              (result) => result.toolCallId === toolCall.id,
            );
            if (dualLlmResultForTool) {
              toolCallParts.push({
                type: "dual-llm-analysis" as const,
                toolCallId: dualLlmResultForTool.toolCallId,
                safeResult: dualLlmResultForTool.result,
                conversations: Array.isArray(dualLlmResultForTool.conversations)
                  ? (dualLlmResultForTool.conversations as Array<{
                      role: "user" | "assistant";
                      content: string | unknown;
                    }>)
                  : [],
              });
            }
          }
        }

        uiMessages.push({ ...uiMessage, parts: toolCallParts });
      } else {
        uiMessages.push(uiMessage);
      }
    }

    return uiMessages;
  }

  private mapResponseToUiMessages(): PartialUIMessage[] {
    return this.responseChoices.map((choice) =>
      this.mapToUiMessage(choice.message),
    );
  }

  // ==========================================================================
  // PRIVATE — Responses API rendering
  // ==========================================================================

  private mapResponsesInputToUiMessages(
    dualLlmAnalyses?: DualLlmAnalysis[],
  ): PartialUIMessage[] {
    const input = this.responsesInput();
    const uiMessages: PartialUIMessage[] = [];

    // Build a call_id → name map for resolving tool result names
    const callIdToName = new Map<string, string>(
      input.flatMap((item) =>
        item.type === "function_call" ? [[item.call_id, item.name]] : [],
      ),
    );

    for (let i = 0; i < input.length; i++) {
      const item = input[i];

      if (item.type === "message") {
        const role =
          item.role === "assistant"
            ? "assistant"
            : item.role === "user"
              ? "user"
              : "system";
        const text = extractResponsesInputText(item.content);
        uiMessages.push({ role, parts: [{ type: "text", text }] });
        continue;
      }

      if (item.type === "function_call") {
        let args: unknown = {};
        try {
          args = JSON.parse(item.arguments);
        } catch {
          args = item.arguments;
        }

        const callId = item.call_id;
        const parts: PartialUIMessage["parts"] = [
          {
            type: "dynamic-tool",
            toolName: item.name,
            toolCallId: callId,
            state: "input-available",
            input: args,
          },
        ];

        // Look ahead for the matching function_call_output
        const outputItem = input
          .slice(i + 1)
          .find(
            (
              m,
            ): m is Extract<
              ResponsesInputItem,
              { type: "function_call_output" }
            > => m.type === "function_call_output" && m.call_id === callId,
          );

        if (outputItem) {
          let output: unknown;
          try {
            output = JSON.parse(outputItem.output);
          } catch {
            output = outputItem.output;
          }
          parts.push({
            type: "dynamic-tool",
            toolName: item.name,
            toolCallId: callId,
            state: "output-available",
            input: args,
            output,
          });

          const dualLlm = dualLlmAnalyses?.find((r) => r.toolCallId === callId);
          if (dualLlm) {
            parts.push({
              type: "dual-llm-analysis",
              toolCallId: dualLlm.toolCallId,
              safeResult: dualLlm.result,
              conversations: Array.isArray(dualLlm.conversations)
                ? (dualLlm.conversations as Array<{
                    role: "user" | "assistant";
                    content: string | unknown;
                  }>)
                : [],
            });
          }
        }

        uiMessages.push({ role: "assistant", parts });
        continue;
      }

      // function_call_output without a preceding function_call (edge case)
      if (item.type === "function_call_output") {
        const toolName = callIdToName.get(item.call_id) ?? "tool-result";
        let output: unknown;
        try {
          output = JSON.parse(item.output);
        } catch {
          output = item.output;
        }
        uiMessages.push({
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName,
              toolCallId: item.call_id,
              state: "output-available",
              input: {},
              output,
            },
          ],
        });
      }
    }

    return uiMessages;
  }

  private mapResponsesOutputToUiMessages(): PartialUIMessage[] {
    return this.responsesOutput().flatMap((item): PartialUIMessage[] => {
      if (item.type === "message") {
        const parts: PartialUIMessage["parts"] = [];
        for (const part of item.content) {
          if (part.type === "output_text") {
            parts.push({ type: "text", text: part.text });
          } else if (part.type === "refusal") {
            parts.push({ type: "text", text: part.refusal });
          }
        }
        return parts.length > 0 ? [{ role: "assistant", parts }] : [];
      }
      if (item.type === "function_call") {
        let args: unknown = {};
        try {
          args = JSON.parse(item.arguments);
        } catch {
          args = item.arguments;
        }
        return [
          {
            role: "assistant",
            parts: [
              {
                type: "dynamic-tool",
                toolName: item.name,
                toolCallId: item.call_id,
                state: "input-available",
                input: args,
              },
            ],
          },
        ];
      }
      return [];
    });
  }

  // ==========================================================================
  // PRIVATE — shape detection + normalized accessors
  // ==========================================================================

  private isResponsesApi(): boolean {
    return (
      "input" in (this.request as unknown as Record<string, unknown>) &&
      !("messages" in (this.request as unknown as Record<string, unknown>))
    );
  }

  private get requestMessages(): RequestMessage[] {
    return (
      (this.request as unknown as { messages?: RequestMessage[] }).messages ??
      []
    );
  }

  private get responseChoices(): ResponseChoice[] {
    return (
      (this.response as unknown as { choices?: ResponseChoice[] }).choices ?? []
    );
  }

  private responsesInput(): ResponsesInputItem[] {
    const raw = (this.request as unknown as Record<string, unknown>).input;
    if (typeof raw === "string") {
      return [{ type: "message", role: "user", content: raw }];
    }
    if (Array.isArray(raw)) return raw as ResponsesInputItem[];
    return [];
  }

  private responsesOutput(): ResponsesOutputItem[] {
    const raw = (this.response as unknown as Record<string, unknown>).output;
    if (Array.isArray(raw)) return raw as ResponsesOutputItem[];
    return [];
  }
}

function extractResponsesInputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || !("type" in part)) return [];
      if (
        (part.type === "input_text" || part.type === "output_text") &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return [part.text];
      }
      return [];
    })
    .join("\n");
}

export default OpenAiChatCompletionInteraction;
