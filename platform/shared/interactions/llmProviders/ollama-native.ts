/**
 * Ollama Native (`/api/chat`) Interaction Utils.
 *
 * Unlike `./ollama.ts` (OpenAI-compatible, reuses the OpenAI class), the native
 * provider logs Ollama's own `/api/chat` request/response shape, so this reads
 * native fields: request `messages[]` with native tool calls, and a single
 * response `message` (not `choices[]`).
 */
import type { archestraApiTypes } from "../../index";
import type { PartialUIMessage } from "../types";
import type { DualLlmAnalysis, Interaction, InteractionUtils } from "./common";

type NativeRequest = archestraApiTypes.OllamaNativeChatRequest;
type NativeResponse = archestraApiTypes.OllamaNativeChatResponse;
type NativeMessage = NativeRequest["messages"][number];

/**
 * Pair one assistant tool call with its result message.
 *
 * Ollama's native wire correlates by name, not id: `tool_calls` carry no `id`
 * and results carry `tool_name`. Comparing `tool_call_id === toolCall.id` is
 * therefore `undefined === undefined` for every native pair, which matched the
 * first result to every call — so a multi-tool turn rendered each call against
 * the wrong output. Prefer ids when present, then names, then arrival order,
 * and never hand the same result to two calls.
 *
 * Returns -1 when nothing is left to pair with.
 */
function matchToolResultIndex(
  results: NativeMessage[],
  toolCall: NonNullable<NativeMessage["tool_calls"]>[number],
  callIndex: number,
  claimed: Set<number>,
): number {
  const unclaimed = (index: number) => !claimed.has(index);

  if (toolCall.id) {
    const byId = results.findIndex(
      (m, index) => unclaimed(index) && m.tool_call_id === toolCall.id,
    );
    if (byId !== -1) return byId;
  }

  const byName = results.findIndex(
    (m, index) => unclaimed(index) && m.tool_name === toolCall.function.name,
  );
  if (byName !== -1) return byName;

  return callIndex < results.length && unclaimed(callIndex) ? callIndex : -1;
}

function toText(content: NativeMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

function toArgsObject(
  args: string | Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (args && typeof args === "object") return args;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

class OllamaNativeChatInteraction implements InteractionUtils {
  private request: NativeRequest;
  private response: NativeResponse;
  modelName: string;

  constructor(interaction: Interaction) {
    this.request = interaction.request as NativeRequest;
    this.response = interaction.response as NativeResponse;
    this.modelName = interaction.model ?? this.request.model;
  }

  isLastMessageToolCall(): boolean {
    const messages = this.request.messages;
    return messages.length > 0 && messages[messages.length - 1].role === "tool";
  }

  getLastToolCallId(): string | null {
    const messages = this.request.messages;
    if (messages.length === 0) return null;
    const last = messages[messages.length - 1];
    return last.role === "tool" ? (last.tool_call_id ?? null) : null;
  }

  getToolNamesUsed(): string[] {
    const used = new Set<string>();
    for (const message of this.request.messages) {
      if (message.role === "assistant" && message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          used.add(toolCall.function.name);
        }
      }
    }
    return Array.from(used);
  }

  // Native `/api/chat` has no `refusal` field, so refusals are not represented
  // on the wire and there is nothing to extract here.
  getToolNamesRefused(): string[] {
    return [];
  }

  getToolRefusedCount(): number {
    return 0;
  }

  getToolNamesRequested(): string[] {
    const requested = new Set<string>();
    for (const toolCall of this.response.message.tool_calls ?? []) {
      requested.add(toolCall.function.name);
    }
    return Array.from(requested);
  }

  getLastUserMessage(): string {
    for (let i = this.request.messages.length - 1; i >= 0; i--) {
      const message = this.request.messages[i];
      if (message.role === "user") return toText(message.content);
    }
    return "";
  }

  getLastAssistantResponse(): string {
    return this.response.message.content ?? "";
  }

  mapToUiMessages(dualLlmAnalyses?: DualLlmAnalysis[]): PartialUIMessage[] {
    return [
      ...this.mapRequestToUiMessages(dualLlmAnalyses),
      this.mapMessageToUi({
        role: "assistant",
        content: this.response.message.content,
        tool_calls: this.response.message.tool_calls ?? undefined,
      }),
    ];
  }

  private mapRequestToUiMessages(
    dualLlmAnalyses?: DualLlmAnalysis[],
  ): PartialUIMessage[] {
    const messages = this.request.messages;
    const uiMessages: PartialUIMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message.role === "tool") continue;

      const uiMessage = this.mapMessageToUi(message);

      if (message.role === "assistant" && message.tool_calls) {
        const parts: PartialUIMessage["parts"] = [...uiMessage.parts];
        // Results that could belong to this assistant turn, in arrival order.
        const followingResults = messages
          .slice(i + 1)
          .filter((m) => m.role === "tool");
        const claimed = new Set<number>();

        message.tool_calls.forEach((toolCall, callIndex) => {
          const resultIndex = matchToolResultIndex(
            followingResults,
            toolCall,
            callIndex,
            claimed,
          );
          const toolResult =
            resultIndex === -1 ? undefined : followingResults[resultIndex];
          if (toolResult && toolResult.role === "tool") {
            claimed.add(resultIndex);
            parts.push(...this.mapMessageToUi(toolResult).parts);
            // Only correlate by id when there is one — on the native wire both
            // sides are undefined and `undefined === undefined` would attach
            // the first analysis to every call.
            const dualLlm = toolCall.id
              ? dualLlmAnalyses?.find((r) => r.toolCallId === toolCall.id)
              : undefined;
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
        });
        uiMessages.push({ ...uiMessage, parts });
      } else {
        uiMessages.push(uiMessage);
      }
    }
    return uiMessages;
  }

  private mapMessageToUi(message: {
    role: string;
    content?: NativeMessage["content"];
    tool_calls?: NativeMessage["tool_calls"];
    tool_call_id?: string;
    tool_name?: string;
  }): PartialUIMessage {
    const parts: PartialUIMessage["parts"] = [];
    const text = toText(message.content);

    if (message.role === "tool") {
      const resolvedToolName = this.resolveToolName(message);
      let output: unknown = text;
      try {
        output = JSON.parse(text);
      } catch {
        output = text;
      }
      parts.push({
        type: "dynamic-tool",
        toolName: resolvedToolName,
        toolCallId: message.tool_call_id ?? "",
        state: "output-available",
        input: {},
        output,
      });
    } else {
      if (text) parts.push({ type: "text", text });
      if (message.role === "assistant" && message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          parts.push({
            type: "dynamic-tool",
            toolName: toolCall.function.name,
            toolCallId: toolCall.id ?? "",
            state: "input-available",
            input: toArgsObject(toolCall.function.arguments),
          });
        }
      }
    }

    const role: PartialUIMessage["role"] =
      message.role === "user"
        ? "user"
        : message.role === "system" || message.role === "developer"
          ? "system"
          : "assistant";

    return { role, parts };
  }

  /**
   * Name a tool result. Ollama's native wire names the tool on the result
   * itself (`tool_name`) and omits ids entirely, so the id lookup only ever
   * succeeds for ollama-ai-provider-v2 traffic — without the `tool_name`
   * fallback every native result in the LLM log renders as "tool-result".
   */
  private resolveToolName(message: {
    tool_call_id?: string;
    tool_name?: string;
  }): string {
    const toolCallId = message.tool_call_id;
    if (toolCallId) {
      for (const request of this.request.messages) {
        if (request.role === "assistant" && request.tool_calls) {
          const match = request.tool_calls.find((t) => t.id === toolCallId);
          if (match) return match.function.name;
        }
      }
    }
    return message.tool_name ?? "tool-result";
  }
}

export default OllamaNativeChatInteraction;
