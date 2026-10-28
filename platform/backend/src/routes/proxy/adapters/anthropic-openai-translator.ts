import { randomUUID } from "node:crypto";
import { ApiError } from "@archestra/shared/types";
import type { Anthropic, OpenAi, UsageView } from "@/types";
import { assertModelRouterCacheControls } from "../model-router-cache-controls";
import type { OpenAiStreamUsage } from "./openai-sse-chunk";
import {
  type NormalizedContentPart,
  normalizeOpenAiContentParts,
  parseDataUrl,
  parseJsonObject,
  stringifyTextContent,
} from "./openai-translator-utils";

type OpenAiRequest = OpenAi.Types.ChatCompletionsRequest;
type OpenAiResponse = OpenAi.Types.ChatCompletionsResponse;
type AnthropicRequest = Anthropic.Types.MessagesRequest;
type AnthropicResponse = Anthropic.Types.MessagesResponse;
/**
 * The OpenAI usage object both wire shapes share. `OpenAiStreamUsage` names it
 * for the streaming chunk; a non-streaming `chat.completion` carries the very
 * same fields.
 */
type OpenAiUsage = OpenAiStreamUsage;

const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192;

type LooseMessage = {
  role: string;
  content?: unknown;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
};

export interface AnthropicOpenaiContext {
  chatcmplId: string;
  createdUnix: number;
  requestedModel: string;
}

export function openaiToAnthropic(req: OpenAiRequest): {
  anthropicBody: AnthropicRequest;
  openaiContext: AnthropicOpenaiContext;
} {
  assertModelRouterCacheControls("anthropic", req);
  const loose = req as OpenAiRequest & {
    stop?: string | string[] | null;
    top_p?: number | null;
  };
  const system: string[] = [];
  const systemBlocks: Array<Record<string, unknown>> = [];
  const messages: AnthropicRequest["messages"] = [];

  for (const message of req.messages as LooseMessage[]) {
    if (message.role === "system" || message.role === "developer") {
      system.push(stringifyTextContent(message.content));
      const blocks = cacheableContentBlocks(message.content);
      if (blocks.some((block) => block.type !== "text")) {
        if (blocks.some((block) => block.cache_control !== undefined))
          throw new ApiError(
            400,
            "Anthropic system cache_control requires text content",
          );
      }
      const textBlocks = blocks.filter((block) => block.type === "text");
      applyMessageCacheControl(textBlocks, message);
      if (systemBlocks.length > 0 && textBlocks.length > 0)
        textBlocks[0].text = `\n\n${textBlocks[0].text}`;
      systemBlocks.push(...textBlocks);
      continue;
    }

    if (message.role === "user") {
      const blocks = cacheableContentBlocks(message.content);
      applyMessageCacheControl(blocks, message);
      messages.push({
        role: "user",
        content:
          typeof message.content === "string" &&
          readCacheControl(message) === undefined
            ? message.content
            : (blocks as AnthropicUserContent),
      });
      continue;
    }

    if (message.role === "assistant") {
      const text = stringifyTextContent(message.content);
      const blocks = cacheableContentBlocks(message.content);
      const content: Array<Record<string, unknown>> = blocks.some(
        (block) => block.cache_control !== undefined,
      )
        ? blocks
        : text
          ? [{ type: "text", text }]
          : [];
      for (const toolCall of message.tool_calls ?? []) {
        if (toolCall.type !== "function") continue;
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input: parseJsonObject(toolCall.function.arguments),
        });
      }
      applyMessageCacheControl(content, message);
      messages.push({
        role: "assistant",
        content:
          content.length > 0
            ? (content as AnthropicRequest["messages"][number]["content"])
            : "",
      });
      continue;
    }

    if (message.role === "tool") {
      // Anthropic tool_result content accepts text and image blocks, so forward
      // images returned by a tool instead of flattening them to text. Text-only
      // results stay a plain string to match prior behavior.
      const normalized = normalizeOpenAiContentParts(message.content);
      const hasMedia = normalized.some((part) => part.kind !== "text");
      const blocks = cacheableContentBlocks(message.content);
      const cache_control = readCacheControl(message);
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id ?? "",
            content:
              hasMedia ||
              blocks.some((block) => block.cache_control !== undefined)
                ? (blocks as AnthropicToolResultContent)
                : stringifyTextContent(message.content),
            ...(cache_control !== undefined ? { cache_control } : {}),
          },
        ],
      });
      continue;
    }
    if (readCacheControl(message) !== undefined)
      throw new ApiError(
        400,
        "Unsupported Anthropic message with cache_control",
      );
  }

  const anthropicBody: AnthropicRequest = {
    model: req.model,
    max_tokens:
      req.max_tokens ??
      req.max_completion_tokens ??
      DEFAULT_ANTHROPIC_MAX_TOKENS,
    messages,
    stream: req.stream === true ? true : undefined,
  };

  if (system.length > 0) {
    anthropicBody.system = systemBlocks.some(
      (block) => block.cache_control !== undefined,
    )
      ? (systemBlocks as AnthropicRequest["system"])
      : system.join("\n\n");
  }

  const cache_control = readCacheControl(req);
  if (cache_control !== undefined) anthropicBody.cache_control = cache_control;

  if (req.temperature !== undefined && req.temperature !== null) {
    anthropicBody.temperature = req.temperature;
  }

  if (loose.top_p !== undefined && loose.top_p !== null) {
    anthropicBody.top_p = loose.top_p;
  }

  if (loose.stop !== undefined && loose.stop !== null) {
    anthropicBody.stop_sequences = Array.isArray(loose.stop)
      ? loose.stop
      : [loose.stop];
  }

  if (req.tools) {
    anthropicBody.tools = req.tools
      .filter((tool) => {
        if (tool.type !== "function" && readCacheControl(tool) !== undefined)
          throw new ApiError(
            400,
            "Anthropic cache_control requires a function tool",
          );
        return tool.type === "function";
      })
      .map((tool) => {
        const outer = readCacheControl(tool);
        const inner = readCacheControl(tool.function);
        if (
          outer !== undefined &&
          inner !== undefined &&
          outer.ttl !== inner.ttl
        )
          throw new ApiError(
            400,
            "Conflicting Anthropic cache_control on tool and function",
          );
        const cache_control = outer ?? inner;
        return {
          name: tool.function.name,
          description: tool.function.description,
          input_schema: tool.function.parameters ?? { type: "object" },
          ...(cache_control !== undefined ? { cache_control } : {}),
        };
      });
  }

  if (req.tool_choice) {
    anthropicBody.tool_choice = toAnthropicToolChoice(req.tool_choice);
  }

  return {
    anthropicBody,
    openaiContext: {
      chatcmplId: `chatcmpl-${randomUUID()}`,
      createdUnix: Math.floor(Date.now() / 1000),
      requestedModel: req.model,
    },
  };
}

export function anthropicResponseToOpenai(
  response: AnthropicResponse,
  ctx: AnthropicOpenaiContext,
): OpenAiResponse {
  let text = "";
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];

  for (const block of response.content) {
    if (block.type === "text") {
      text += block.text;
      continue;
    }

    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const usage = anthropicUsageToOpenai(response.usage);

  return {
    id: ctx.chatcmplId,
    object: "chat.completion",
    created: ctx.createdUnix,
    model: ctx.requestedModel,
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: mapStopReason(response.stop_reason),
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
    usage,
  } as OpenAiResponse;
}

/**
 * Map Anthropic's `usage` onto the OpenAI usage fields.
 *
 * Anthropic reports `input_tokens` as the prompt tokens that MISSED the cache;
 * `cache_read_input_tokens` and `cache_creation_input_tokens` are counted
 * separately and are not included in it. OpenAI's `prompt_tokens` is the gross
 * prompt count, with cache hits repeated as a subset in
 * `prompt_tokens_details.cached_tokens`. Forwarding `input_tokens` straight
 * across therefore drops the cached prefix entirely: a turn that reads 90k
 * tokens back from the cache and misses on 4 reports `prompt_tokens: 4`, and
 * the cache read is unrecoverable from the wire.
 *
 * Cache writes remain a separate subset so clients and pooled transports can
 * recover uncached input and apply the provider's write tariff.
 */
function anthropicUsageToOpenai(
  usage: AnthropicResponse["usage"],
): OpenAiUsage {
  return buildOpenAiUsage({
    uncachedInputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    cacheWrite1hTokens:
      usage.cache_creation?.ephemeral_1h_input_tokens ?? undefined,
  });
}

/**
 * Same mapping as `anthropicUsageToOpenai`, but from the stream accumulator,
 * whose `UsageView` carries the same uncached-input normalization. Streaming
 * and non-streaming answer the same route, so they must report the same numbers
 * for the same turn.
 */
export function anthropicUsageViewToOpenai(
  usage: UsageView | null | undefined,
): OpenAiUsage | undefined {
  if (!usage) {
    return undefined;
  }
  return buildOpenAiUsage({
    uncachedInputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    cacheWrite1hTokens: usage.cacheWrite1hTokens,
  });
}

function buildOpenAiUsage(params: {
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens?: number;
}): OpenAiUsage {
  const promptTokens =
    params.uncachedInputTokens +
    params.cacheReadTokens +
    params.cacheWriteTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: params.outputTokens,
    total_tokens: promptTokens + params.outputTokens,
    // Omitted rather than zeroed when nothing was cached, so the field's
    // presence still means "this provider reported cache usage".
    ...(params.cacheReadTokens > 0 || params.cacheWriteTokens > 0
      ? {
          prompt_tokens_details: {
            cached_tokens: params.cacheReadTokens,
            ...(params.cacheWriteTokens > 0
              ? { cache_write_tokens: params.cacheWriteTokens }
              : {}),
            ...((params.cacheWrite1hTokens ?? 0) > 0
              ? { cache_write_1h_tokens: params.cacheWrite1hTokens }
              : {}),
          },
        }
      : {}),
  };
}

export function mapStopReason(
  reason: AnthropicResponse["stop_reason"],
): "stop" | "length" | "tool_calls" | "content_filter" {
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "stop_sequence" || reason === "end_turn") return "stop";
  return "stop";
}

type AnthropicUserContent = AnthropicRequest["messages"][number]["content"];
type AnthropicToolResultContent = NonNullable<
  Extract<
    Extract<AnthropicUserContent, readonly unknown[]>[number],
    { type: "tool_result" }
  >["content"]
>;

function readCacheControl(
  value: unknown,
): { type: "ephemeral"; ttl?: "5m" | "1h" } | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("cache_control" in value) ||
    value.cache_control === undefined ||
    value.cache_control === null
  )
    return undefined;
  const control = value.cache_control;
  if (
    !control ||
    typeof control !== "object" ||
    !("type" in control) ||
    control.type !== "ephemeral" ||
    ("ttl" in control &&
      control.ttl !== undefined &&
      control.ttl !== "5m" &&
      control.ttl !== "1h")
  ) {
    throw new ApiError(
      400,
      "Anthropic cache_control requires type ephemeral and an optional 5m or 1h ttl",
    );
  }
  return control as { type: "ephemeral"; ttl?: "5m" | "1h" };
}

function applyMessageCacheControl(
  blocks: Array<Record<string, unknown>>,
  message: unknown,
): void {
  const control = readCacheControl(message);
  if (control === undefined) return;
  const last = blocks.at(-1);
  if (!last)
    throw new ApiError(
      400,
      "Anthropic cache_control requires cacheable message content",
    );
  const existing = readCacheControl(last);
  if (
    existing !== undefined &&
    (existing.type !== control.type || existing.ttl !== control.ttl)
  )
    throw new ApiError(
      400,
      "Conflicting Anthropic cache_control on message and final content block",
    );
  last.cache_control = control;
}

function cacheableContentBlocks(
  content: unknown,
): Array<Record<string, unknown>> {
  if (typeof content === "string")
    return content ? [{ type: "text", text: content }] : [];
  const blocks: Array<Record<string, unknown>> = [];
  for (const raw of Array.isArray(content) ? content : []) {
    const cache_control = readCacheControl(raw);
    const converted = normalizeOpenAiContentParts([raw]).flatMap((part) => {
      const block = normalizedPartToAnthropicBlock(part);
      return block && !(block.type === "text" && block.text === "")
        ? [block]
        : [];
    });
    if (cache_control !== undefined && converted.length === 0)
      throw new ApiError(
        400,
        "Unsupported Anthropic content part with cache_control",
      );
    for (const block of converted)
      blocks.push({
        ...block,
        ...(cache_control !== undefined ? { cache_control } : {}),
      });
  }
  return blocks;
}

function normalizedPartToAnthropicBlock(
  part: NormalizedContentPart,
): Record<string, unknown> | null {
  switch (part.kind) {
    case "text":
      return { type: "text", text: part.text };
    case "image": {
      const inline = parseDataUrl(part.url);
      if (inline) {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: inline.mimeType,
            data: inline.data,
          },
        };
      }
      if (/^https?:\/\//i.test(part.url)) {
        return { type: "image", source: { type: "url", url: part.url } };
      }
      return null;
    }
    case "file": {
      const inline = parseDataUrl(part.fileData);
      if (!inline || inline.mimeType !== "application/pdf") return null;
      return {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: inline.data,
        },
      };
    }
    case "audio":
      return null;
  }
}

function toAnthropicToolChoice(
  toolChoice: OpenAiRequest["tool_choice"],
): AnthropicRequest["tool_choice"] {
  if (toolChoice === "required") return { type: "any" };
  if (toolChoice === "none") return { type: "none" };
  if (
    typeof toolChoice === "object" &&
    toolChoice?.type === "function" &&
    toolChoice.function?.name
  ) {
    return {
      type: "tool",
      name: toolChoice.function.name,
    };
  }
  return { type: "auto" };
}
