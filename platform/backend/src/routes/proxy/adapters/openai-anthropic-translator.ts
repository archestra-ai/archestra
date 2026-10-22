/**
 * Anthropic Messages in, OpenAI Chat Completions out.
 *
 * The reverse of `anthropic-openai-translator.ts`. A model pool uses it when a
 * client that speaks Anthropic's wire (Claude Code) reaches a member that only
 * speaks OpenAI's (Z.ai, OpenAI, Azure, vLLM, ...): the request goes out as a
 * chat completion and the answer comes back as an Anthropic message or event
 * stream, so the client and the proxy pipeline only ever see Anthropic shapes.
 *
 * Thinking blocks are dropped in both directions: an OpenAI-compatible
 * provider cannot verify an Anthropic thinking signature, and the reasoning
 * text some of them stream has no signature to replay.
 */
import { randomUUID } from "node:crypto";
import type { Anthropic, OpenAi } from "@/types";
import { parseJsonObject } from "./openai-translator-utils";

type AnthropicRequest = Anthropic.Types.MessagesRequest;
type AnthropicResponse = Anthropic.Types.MessagesResponse;
type OpenAiRequest = OpenAi.Types.ChatCompletionsRequest;
type OpenAiResponse = OpenAi.Types.ChatCompletionsResponse;
type OpenAiChunk = OpenAi.Types.ChatCompletionChunk;

// biome-ignore lint/suspicious/noExplicitAny: both wires carry fields the Zod schemas don't describe
type Loose = any;

/** An Anthropic stream event, as the Anthropic adapter's stream adapter reads it. */
export type AnthropicStreamEvent = Record<string, unknown> & { type: string };

export interface OpenaiAnthropicContext {
  messageId: string;
  /** The model the client asked for, echoed back as Anthropic does. */
  requestedModel: string;
}

export function anthropicToOpenai(req: AnthropicRequest): {
  openaiBody: OpenAiRequest;
  anthropicContext: OpenaiAnthropicContext;
} {
  const loose = req as Loose;
  const messages: Array<Record<string, unknown>> = [];

  const system = systemText(loose.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of loose.messages ?? []) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    const blocks: Loose[] = Array.isArray(message.content)
      ? message.content
      : [];
    if (message.role === "assistant") {
      const text = blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      const toolCalls = blocks
        .filter((block) => block.type === "tool_use")
        .map((block) => ({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        }));
      messages.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    // A user turn: tool results become `tool` messages, which OpenAI requires
    // straight after the assistant turn that called them; anything else in
    // the turn follows as one user message.
    const parts: Array<Record<string, unknown>> = [];
    for (const block of blocks) {
      if (block.type === "tool_result") {
        messages.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: toolResultContent(block),
        });
        continue;
      }
      const part = blockToOpenAiPart(block);
      if (part) parts.push(part);
    }
    if (parts.length > 0) {
      messages.push({
        role: "user",
        content:
          parts.length === 1 && parts[0].type === "text"
            ? parts[0].text
            : parts,
      });
    }
  }

  const openaiBody: Loose = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
  };
  if (req.stream === true) openaiBody.stream = true;
  if (loose.temperature != null) openaiBody.temperature = loose.temperature;
  if (loose.top_p != null) openaiBody.top_p = loose.top_p;
  if (Array.isArray(loose.stop_sequences) && loose.stop_sequences.length > 0) {
    openaiBody.stop = loose.stop_sequences;
  }
  // Server tools (web search, code execution, ...) run inside Anthropic and
  // have no OpenAI counterpart, so only client tools cross over.
  const tools = (loose.tools ?? []).filter(
    (tool: Loose) => tool.input_schema !== undefined,
  );
  if (tools.length > 0) {
    openaiBody.tools = tools.map((tool: Loose) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.input_schema,
      },
    }));
    if (loose.tool_choice) {
      openaiBody.tool_choice = toOpenAiToolChoice(loose.tool_choice);
    }
  }

  return {
    openaiBody: openaiBody as OpenAiRequest,
    anthropicContext: {
      messageId: `msg_${randomUUID().replaceAll("-", "")}`,
      requestedModel: req.model,
    },
  };
}

export function openaiResponseToAnthropic(
  response: OpenAiResponse,
  ctx: OpenaiAnthropicContext,
): AnthropicResponse {
  const choice = (response as Loose).choices?.[0];
  const message = choice?.message ?? {};
  const content: Array<Record<string, unknown>> = [];
  const text = typeof message.content === "string" ? message.content : "";
  if (text) content.push({ type: "text", text });
  for (const toolCall of message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function?.name ?? "",
      input: parseJsonObject(toolCall.function?.arguments),
    });
  }
  return {
    id: ctx.messageId,
    type: "message",
    role: "assistant",
    model: ctx.requestedModel,
    content,
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: openAiUsageToAnthropic((response as Loose).usage),
  } as unknown as AnthropicResponse;
}

/**
 * Turns an OpenAI chunk stream into Anthropic's event stream: one
 * `message_start`, a content block per text run or tool call, then
 * `message_delta` with the stop reason and usage, and `message_stop`. OpenAI
 * reports usage on its last chunk, so input tokens arrive in `message_delta`.
 * `finish` throws when the stream ended without a finish reason.
 */
export function createOpenaiToAnthropicStreamTranslator(
  ctx: OpenaiAnthropicContext,
): {
  translate(chunk: OpenAiChunk): AnthropicStreamEvent[];
  finish(): AnthropicStreamEvent[];
} {
  let started = false;
  let nextBlockIndex = 0;
  let openBlock: { index: number; kind: "text" | "tool" } | null = null;
  const toolBlockByOpenAiIndex = new Map<number, number>();
  let finishReason: string | null = null;
  let usage: Loose = null;

  function start(events: AnthropicStreamEvent[]) {
    if (started) return;
    started = true;
    events.push({
      type: "message_start",
      message: {
        id: ctx.messageId,
        type: "message",
        role: "assistant",
        model: ctx.requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  function closeBlock(events: AnthropicStreamEvent[]) {
    if (!openBlock) return;
    events.push({ type: "content_block_stop", index: openBlock.index });
    openBlock = null;
  }

  return {
    translate(chunk) {
      const events: AnthropicStreamEvent[] = [];
      start(events);
      const loose = chunk as Loose;
      if (loose.usage) usage = loose.usage;
      const choice = loose.choices?.[0];
      if (!choice) return events;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (openBlock?.kind !== "text") {
          closeBlock(events);
          openBlock = { index: nextBlockIndex++, kind: "text" };
          events.push({
            type: "content_block_start",
            index: openBlock.index,
            content_block: { type: "text", text: "" },
          });
        }
        events.push({
          type: "content_block_delta",
          index: openBlock.index,
          delta: { type: "text_delta", text: delta.content },
        });
      }
      for (const toolCall of delta.tool_calls ?? []) {
        const openAiIndex = toolCall.index ?? 0;
        let blockIndex = toolBlockByOpenAiIndex.get(openAiIndex);
        if (blockIndex === undefined) {
          closeBlock(events);
          blockIndex = nextBlockIndex++;
          toolBlockByOpenAiIndex.set(openAiIndex, blockIndex);
          openBlock = { index: blockIndex, kind: "tool" };
          events.push({
            type: "content_block_start",
            index: blockIndex,
            content_block: {
              type: "tool_use",
              id: toolCall.id ?? `toolu_${randomUUID().replaceAll("-", "")}`,
              name: toolCall.function?.name ?? "",
              input: {},
            },
          });
        }
        const args = toolCall.function?.arguments;
        if (typeof args === "string" && args.length > 0) {
          events.push({
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: args },
          });
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
      return events;
    },

    finish() {
      // A stream that ends without a finish reason was cut off; reporting
      // end_turn would pass a truncated answer off as a whole one.
      if (finishReason === null) {
        throw new Error("The upstream stream ended before it finished");
      }
      const events: AnthropicStreamEvent[] = [];
      start(events);
      closeBlock(events);
      events.push({
        type: "message_delta",
        delta: {
          stop_reason: mapFinishReason(finishReason),
          stop_sequence: null,
        },
        usage: openAiUsageToAnthropic(usage),
      });
      events.push({ type: "message_stop" });
      return events;
    },
  };
}

// === Internal helpers ===

function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .filter((block: Loose) => block?.type === "text")
    .map((block: Loose) => block.text)
    .join("\n\n");
}

function toolResultContent(block: Loose): unknown {
  const prefix = block.is_error ? "Error: " : "";
  if (typeof block.content === "string") return `${prefix}${block.content}`;
  const parts = (Array.isArray(block.content) ? block.content : [])
    .map(blockToOpenAiPart)
    .filter((part: unknown) => part !== null);
  if (parts.every((part: Loose) => part.type === "text")) {
    return `${prefix}${parts.map((part: Loose) => part.text).join("")}`;
  }
  return prefix ? [{ type: "text", text: prefix }, ...parts] : parts;
}

function blockToOpenAiPart(block: Loose): Record<string, unknown> | null {
  if (block?.type === "text") return { type: "text", text: block.text };
  if (block?.type === "image") {
    const source = block.source ?? {};
    if (source.type === "base64") {
      return {
        type: "image_url",
        image_url: { url: `data:${source.media_type};base64,${source.data}` },
      };
    }
    if (source.type === "url") {
      return { type: "image_url", image_url: { url: source.url } };
    }
  }
  return null;
}

function toOpenAiToolChoice(choice: Loose): unknown {
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && choice.name) {
    return { type: "function", function: { name: choice.name } };
  }
  return "auto";
}

function mapFinishReason(
  reason: string | null | undefined,
): AnthropicResponse["stop_reason"] {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  return "end_turn";
}

/**
 * OpenAI's `prompt_tokens` is the gross prompt with cache hits as a subset;
 * Anthropic's `input_tokens` is only the part that missed the cache.
 */
function openAiUsageToAnthropic(usage: Loose): Record<string, number> {
  const prompt = Number(usage?.prompt_tokens ?? 0);
  const cached = Number(usage?.prompt_tokens_details?.cached_tokens ?? 0);
  return {
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: Number(usage?.completion_tokens ?? 0),
    ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
  };
}
