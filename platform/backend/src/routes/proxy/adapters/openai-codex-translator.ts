/**
 * Pure translation between the proxy's OpenAI chat-completions wire format and
 * the ChatGPT/Codex subscription **Responses API**
 * (`https://chatgpt.com/backend-api/codex/responses`).
 *
 * The Codex backend speaks only the Responses API and imposes a few mandatory
 * transforms (confirmed against the Codex CLI / OpenCode): `store: false` (the
 * backend is stateless), `stream: true` always, `include:
 * ["reasoning.encrypted_content"]` (reasoning continuity under store:false), and
 * the Codex persona in `instructions`. The Codex adapter's duck-typed client
 * (see ./openai-codex-client) builds the request with `buildCodexResponsesRequest`,
 * calls the Responses API, and maps the streamed events back to OpenAI chat
 * chunks with these helpers so the rest of the proxy (cost, policies, TOON,
 * metrics) keeps operating on chat-completions shapes.
 */
import { randomUUID } from "node:crypto";
import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import logger from "@/logging";
import { OPENAI_CODEX_INSTRUCTIONS } from "@/services/openai-codex-credentials";
import { ApiError, type OpenAi } from "@/types";

type ChatCompletionsRequest = OpenAi.Types.ChatCompletionsRequest;
type ChatCompletionsResponse = OpenAi.Types.ChatCompletionsResponse;
type ChatCompletionChunk = OpenAi.Types.ChatCompletionChunk;
type Usage = OpenAi.Types.Usage;

type LooseItem = Record<string, unknown>;

/**
 * Builds the Codex Responses request from an inbound chat-completions request,
 * applying the mandatory Codex-backend transforms. Always streaming upstream —
 * the client accumulates for non-streaming callers.
 */
export function buildCodexResponsesRequest(
  params: ChatCompletionsRequest,
): ResponseCreateParamsStreaming {
  const request: LooseItem = {
    model: params.model,
    instructions: OPENAI_CODEX_INSTRUCTIONS,
    input: chatMessagesToResponsesInput(params.messages),
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    reasoning: {
      effort: reasoningEffort(params),
      summary: "auto",
    },
    parallel_tool_calls:
      (params as { parallel_tool_calls?: boolean }).parallel_tool_calls ?? true,
  };

  const tools = chatToolsToResponsesTools(params.tools);
  if (tools.length > 0) {
    request.tools = tools;
    request.tool_choice = chatToolChoiceToResponses(params.tool_choice);
  }

  return request as unknown as ResponseCreateParamsStreaming;
}

/**
 * Maps a Codex Responses event stream to OpenAI chat-completion chunks. Emits an
 * opening role chunk, text deltas, incremental tool-call deltas, and a closing
 * chunk carrying finish_reason + usage.
 */
export async function* codexResponsesStreamToChatChunks(params: {
  stream: AsyncIterable<ResponseStreamEvent>;
  model: string;
  completionId: string;
  createdUnixSeconds: number;
}): AsyncGenerator<ChatCompletionChunk> {
  const { stream, model, completionId, createdUnixSeconds } = params;
  const base = { completionId, model, createdUnixSeconds };

  yield makeChunk({ ...base, delta: { role: "assistant", content: "" } });

  const toolIndexByItemId = new Map<string, number>();
  let sawToolCall = false;
  let usage: Usage | undefined;
  let finishReason: ChatFinishReason = "stop";

  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      yield makeChunk({ ...base, delta: { content: event.delta } });
      continue;
    }

    if (
      event.type === "response.output_item.added" &&
      isFunctionCallItem(event.item)
    ) {
      const index = toolIndexByItemId.size;
      const itemId = event.item.id ?? event.item.call_id;
      toolIndexByItemId.set(itemId, index);
      sawToolCall = true;
      yield makeChunk({
        ...base,
        delta: {
          tool_calls: [
            {
              index,
              id: event.item.call_id,
              type: "function",
              function: { name: event.item.name, arguments: "" },
            },
          ],
        },
      });
      continue;
    }

    if (event.type === "response.function_call_arguments.delta") {
      const knownIndex = toolIndexByItemId.get(event.item_id);
      if (knownIndex === undefined) {
        // A delta for an item we never saw added would otherwise silently
        // corrupt the first tool call's arguments. Surface it and fall back.
        logger.warn(
          { itemId: event.item_id },
          "[OpenAiCodexTranslator] arguments delta for unknown tool-call item; defaulting to index 0",
        );
      }
      const index = knownIndex ?? 0;
      yield makeChunk({
        ...base,
        delta: {
          tool_calls: [{ index, function: { arguments: event.delta } }],
        },
      });
      continue;
    }

    if (event.type === "response.completed") {
      usage = mapResponsesUsage(event.response.usage);
      finishReason = sawToolCall ? "tool_calls" : "stop";
      break;
    }

    if (event.type === "response.failed") {
      // A real upstream failure. Throw so the proxy's error path surfaces it and
      // persists an error interaction — otherwise a masked "success" chunk would
      // report finish_reason "length" and skip all logging/metrics.
      const err = (
        event.response as { error?: { message?: string; code?: string } }
      ).error;
      throw new ApiError(
        502,
        `Codex request failed${err?.message ? `: ${err.message}` : err?.code ? `: ${err.code}` : ""}`,
      );
    }

    if (event.type === "response.incomplete") {
      // Not an error (e.g. hit max output tokens): keep the partial output, but
      // carry usage so the turn is still metered/persisted, and map the reason.
      usage = mapResponsesUsage(event.response.usage);
      const reason = (
        event.response as { incomplete_details?: { reason?: string } }
      ).incomplete_details?.reason;
      finishReason = reason === "content_filter" ? "content_filter" : "length";
      break;
    }
  }

  yield makeChunk({
    ...base,
    delta: {},
    finishReason,
    usage,
  });
}

/**
 * Folds the translated chat chunks into a single non-streaming chat completion,
 * so `execute` (non-streaming) callers get the shape they expect while the
 * upstream Codex call is always streamed.
 */
export async function foldChatChunksToResponse(params: {
  chunks: AsyncIterable<ChatCompletionChunk>;
  model: string;
  completionId: string;
  createdUnixSeconds: number;
}): Promise<ChatCompletionsResponse> {
  const { chunks, model, completionId, createdUnixSeconds } = params;

  let content = "";
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];
  let finishReason: ChatFinishReason = "stop";
  let usage: Usage | undefined;

  for await (const chunk of chunks) {
    const choice = chunk.choices[0];
    if (chunk.usage) {
      usage = chunk.usage;
    }
    if (!choice) {
      continue;
    }
    const delta = choice.delta as {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    if (typeof delta.content === "string") {
      content += delta.content;
    }
    for (const toolDelta of delta.tool_calls ?? []) {
      const existing = toolCalls[toolDelta.index] ?? {
        id: toolDelta.id ?? `call_${randomUUID()}`,
        type: "function" as const,
        function: { name: "", arguments: "" },
      };
      if (toolDelta.id) {
        existing.id = toolDelta.id;
      }
      if (toolDelta.function?.name) {
        existing.function.name = toolDelta.function.name;
      }
      if (toolDelta.function?.arguments) {
        existing.function.arguments += toolDelta.function.arguments;
      }
      toolCalls[toolDelta.index] = existing;
    }
    if (choice.finish_reason) {
      finishReason = choice.finish_reason as ChatFinishReason;
    }
  }

  const filledToolCalls = toolCalls.filter(Boolean);
  return {
    id: completionId,
    object: "chat.completion",
    created: createdUnixSeconds,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(filledToolCalls.length > 0
            ? { tool_calls: filledToolCalls }
            : {}),
        },
        finish_reason: finishReason,
      },
    ],
    ...(usage ? { usage } : {}),
  } as unknown as ChatCompletionsResponse;
}

// ===== Internal helpers =====

type ChatFinishReason = "stop" | "tool_calls" | "length" | "content_filter";

function chatMessagesToResponsesInput(
  messages: ChatCompletionsRequest["messages"],
): ResponseInput {
  const input: LooseItem[] = [];

  for (const message of messages ?? []) {
    const role = message.role;

    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id:
          "tool_call_id" in message && typeof message.tool_call_id === "string"
            ? message.tool_call_id
            : "unknown",
        output: contentToText(message.content),
      });
      continue;
    }

    if (role === "assistant") {
      // An assistant turn may carry both tool calls and text. We emit the
      // `function_call` items first, then the text as a separate `message` item.
      // Chat-completions models the two as parallel fields on one message (no
      // inherent order between them), so this fixed ordering is a faithful,
      // lossless mapping — the Codex backend consumes them as a set, not a
      // sequence.
      const toolCalls =
        "tool_calls" in message && Array.isArray(message.tool_calls)
          ? message.tool_calls
          : [];
      for (const toolCall of toolCalls) {
        if (toolCall.type !== "function") {
          continue;
        }
        input.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        });
      }
      const text = contentToText(message.content);
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      continue;
    }

    // user / system / developer → an input message. The caller's system prompt
    // rides as a developer item (the Codex persona owns `instructions`). User
    // turns keep image parts as input_image (the Codex backend accepts them, as
    // the Codex CLI sends them) instead of silently dropping them to text.
    input.push({
      type: "message",
      role: role === "user" ? "user" : "developer",
      content:
        role === "user"
          ? toResponsesInputContent(message.content)
          : [{ type: "input_text", text: contentToText(message.content) }],
    });
  }

  return input as unknown as ResponseInput;
}

function chatToolsToResponsesTools(
  tools: ChatCompletionsRequest["tools"],
): LooseItem[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools.flatMap((tool) => {
    if (tool.type !== "function") {
      return [];
    }
    return [
      {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters ?? {},
      },
    ];
  });
}

function chatToolChoiceToResponses(
  toolChoice: ChatCompletionsRequest["tool_choice"],
): string | { type: "function"; name: string } {
  if (toolChoice === "none") {
    return "none";
  }
  if (toolChoice === "required") {
    return "required";
  }
  // Forced-function form: { type: "function", function: { name } } → the
  // Responses API's { type: "function", name }. Dropping this to "auto" would
  // let the model skip the tool the caller demanded.
  if (
    toolChoice &&
    typeof toolChoice === "object" &&
    toolChoice.type === "function" &&
    toolChoice.function?.name
  ) {
    return { type: "function", name: toolChoice.function.name };
  }
  return "auto";
}

function reasoningEffort(
  params: ChatCompletionsRequest,
): "minimal" | "low" | "medium" | "high" {
  const effort = (params as { reasoning_effort?: unknown }).reasoning_effort;
  if (
    effort === "minimal" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high"
  ) {
    return effort;
  }
  return "medium";
}

function mapResponsesUsage(
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
      }
    | null
    | undefined,
): Usage | undefined {
  if (!usage) {
    return undefined;
  }
  const promptTokens = usage.input_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.total_tokens ?? promptTokens + completionTokens,
  } as Usage;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (part === null || typeof part !== "object") {
        return "";
      }
      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Maps a chat message's content to Responses input content parts, preserving
 * images (chat `image_url` → Responses `input_image`) rather than dropping them.
 */
function toResponsesInputContent(content: unknown): LooseItem[] {
  if (typeof content === "string") {
    return content ? [{ type: "input_text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part): LooseItem[] => {
    if (!part || typeof part !== "object") {
      return [];
    }
    const record = part as Record<string, unknown>;
    if (typeof record.text === "string") {
      return [{ type: "input_text", text: record.text }];
    }
    if (record.type === "image_url") {
      const url = extractImageUrl(record.image_url);
      if (url) {
        return [{ type: "input_image", image_url: url }];
      }
    }
    return [];
  });
}

/** Pulls the URL from a chat `image_url` part (object `{url}` or bare string). */
function extractImageUrl(imageUrl: unknown): string | undefined {
  if (typeof imageUrl === "string") {
    return imageUrl;
  }
  if (
    imageUrl &&
    typeof imageUrl === "object" &&
    typeof (imageUrl as { url?: unknown }).url === "string"
  ) {
    return (imageUrl as { url: string }).url;
  }
  return undefined;
}

function isFunctionCallItem(item: unknown): item is {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
} {
  return (
    !!item &&
    typeof item === "object" &&
    "type" in item &&
    (item as { type?: unknown }).type === "function_call"
  );
}

function makeChunk(params: {
  completionId: string;
  model: string;
  createdUnixSeconds: number;
  delta: Record<string, unknown>;
  finishReason?: ChatFinishReason;
  usage?: Usage;
}): ChatCompletionChunk {
  return {
    id: params.completionId,
    object: "chat.completion.chunk",
    created: params.createdUnixSeconds,
    model: params.model,
    choices: [
      {
        index: 0,
        delta: params.delta,
        finish_reason: params.finishReason ?? null,
      },
    ],
    ...(params.usage ? { usage: params.usage } : {}),
  } as ChatCompletionChunk;
}
