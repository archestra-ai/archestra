import { randomUUID } from "node:crypto";
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import type { Bedrock, OpenAi, StreamAccumulatorState } from "@/types";
import {
  parseJsonObject,
  stringifyTextContent,
} from "./openai-translator-utils";

type OpenAiRequest = OpenAi.Types.ChatCompletionsRequest;
type OpenAiResponse = OpenAi.Types.ChatCompletionsResponse;
type BedrockRequest = Bedrock.Types.ConverseRequest;
type BedrockResponse = Bedrock.Types.ConverseResponse;
type BedrockMessage = Bedrock.Types.Message;
type BedrockContentBlock = Bedrock.Types.ContentBlock;
type BedrockStreamEvent = ConverseStreamOutput;

/**
 * Context carried from the route to the adapter wrappers.
 * Captures OpenAI-specific envelope fields so response/stream translation
 * can reproduce the exact wire shape OpenAI clients expect.
 */
export interface OpenaiContext {
  chatcmplId: string;
  createdUnix: number;
  requestedModel: string;
  includeUsageInStream: boolean;
}

export interface OpenaiToConverseResult {
  converseBody: BedrockRequest;
  openaiContext: OpenaiContext;
}

// biome-ignore lint/suspicious/noExplicitAny: translator touches fields Zod schemas don't yet describe
type Loose = any;

/**
 * Translate an OpenAI ChatCompletions request to a Bedrock Converse request body.
 * This is the ONE inbound translation point. After this function runs, the
 * entire LLM-proxy pipeline sees Converse shapes.
 */
export function openaiToConverse(req: OpenAiRequest): OpenaiToConverseResult {
  const loose = req as Loose;
  const system: Array<{ text: string }> = [];
  const messages: BedrockMessage[] = [];

  for (const m of req.messages ?? []) {
    const role = (m as Loose).role as string;
    if (role === "system" || role === "developer") {
      system.push({ text: stringifyTextContent((m as Loose).content, "") });
      continue;
    }

    if (role === "user") {
      messages.push({
        role: "user",
        content: userContentToBedrock((m as Loose).content),
      });
      continue;
    }

    if (role === "assistant") {
      const content: BedrockContentBlock[] = [];
      const text = stringifyAssistantText((m as Loose).content);
      if (text) content.push({ text });
      for (const tc of ((m as Loose).tool_calls ?? []) as Loose[]) {
        if (tc?.type === "function" && tc.function) {
          content.push({
            toolUse: {
              toolUseId: String(tc.id ?? ""),
              name: String(tc.function.name ?? ""),
              input: parseJsonObject(tc.function.arguments),
            },
          });
        }
      }
      messages.push({ role: "assistant", content });
      continue;
    }

    if (role === "tool") {
      const block = {
        toolResult: {
          toolUseId: String((m as Loose).tool_call_id ?? ""),
          content: toolResultContent((m as Loose).content),
        },
      };
      const prev = messages[messages.length - 1];
      if (prev && prev.role === "user") {
        prev.content.push(block as BedrockContentBlock);
      } else {
        messages.push({
          role: "user",
          content: [block as BedrockContentBlock],
        });
      }
    }
  }

  const inferenceConfig = buildInferenceConfig(loose);
  const toolConfig = buildToolConfig(loose);

  const converseBody: BedrockRequest = {
    modelId: req.model,
    messages,
    _isStreaming: Boolean(loose.stream),
  };
  if (system.length > 0) converseBody.system = system;
  if (inferenceConfig) converseBody.inferenceConfig = inferenceConfig;
  if (toolConfig) converseBody.toolConfig = toolConfig;

  const openaiContext: OpenaiContext = {
    chatcmplId: newChatcmplId(),
    createdUnix: Math.floor(Date.now() / 1000),
    requestedModel: req.model,
    includeUsageInStream: loose.stream_options?.include_usage === true,
  };

  return { converseBody, openaiContext };
}

/**
 * Translate a Bedrock Converse response to an OpenAI chat.completion response.
 * The ONE outbound translation point for non-streaming requests.
 */
export function converseResponseToOpenai(
  resp: BedrockResponse,
  ctx: OpenaiContext,
): OpenAiResponse {
  const blocks = resp.output?.message?.content ?? [];
  let text = "";
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];

  for (const b of blocks as Loose[]) {
    if (b && typeof b === "object" && typeof b.text === "string") {
      text += b.text;
    } else if (b?.toolUse) {
      toolCalls.push({
        id: String(b.toolUse.toolUseId ?? ""),
        type: "function",
        function: {
          name: String(b.toolUse.name ?? ""),
          arguments: JSON.stringify(b.toolUse.input ?? {}),
        },
      });
    }
  }

  const finishReason = mapStopReason(resp.stopReason);
  const usage = {
    prompt_tokens: resp.usage?.inputTokens ?? 0,
    completion_tokens: resp.usage?.outputTokens ?? 0,
    total_tokens:
      (resp.usage?.inputTokens ?? 0) + (resp.usage?.outputTokens ?? 0),
  };

  return {
    id: ctx.chatcmplId,
    object: "chat.completion",
    created: ctx.createdUnix,
    model: ctx.requestedModel,
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: finishReason,
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

/** Map a Bedrock stopReason to the OpenAI finish_reason string. */
export function mapStopReason(
  stopReason: string | undefined,
): OpenAi.Types.FinishReason {
  switch (stopReason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "guardrail_intervened":
    case "content_filtered":
      return "content_filter";
    default:
      return "stop";
  }
}

// =============================================================================
// Streaming SSE encoder
// =============================================================================

/**
 * Converts Bedrock Converse stream events to OpenAI Chat Completions SSE bytes.
 * Stateful: holds back the finish_reason chunk until formatEnd / formatCompleteText
 * so it's never emitted before late-stage refusal content. See plan, "finish-reason
 * hold-back".
 */
export interface ConverseToOpenaiSseEncoder {
  encodeBedrockEvent(event: BedrockStreamEvent): Uint8Array | null;
  formatEnd(): Uint8Array;
  formatTextDelta(text: string): Uint8Array;
  formatCompleteText(text: string): Uint8Array[];
  buildFinalResponseFromState(state: StreamAccumulatorState): OpenAiResponse;
}

const ENCODER = new TextEncoder();

export function createConverseToOpenaiSseEncoder(
  ctx: OpenaiContext,
): ConverseToOpenaiSseEncoder {
  // Maps Bedrock contentBlockIndex → the position of the matching tool call
  // in the OpenAI tool_calls[] stream. OpenAI uses a dense 0..N-1 index that
  // only counts tool-use blocks; Bedrock's contentBlockIndex is dense across
  // all blocks (text + tool_use). We need to translate.
  const toolIndexByBlock = new Map<number, number>();
  let nextToolIndex = 0;
  let pendingFinishReason: OpenAi.Types.FinishReason | null = null;
  let rolePrepended = false;

  function envelope(delta: Loose, finishReason: Loose = null): Loose {
    return {
      id: ctx.chatcmplId,
      object: "chat.completion.chunk",
      created: ctx.createdUnix,
      model: ctx.requestedModel,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
  }

  function sse(obj: Loose): Uint8Array {
    return ENCODER.encode(`data: ${JSON.stringify(obj)}\n\n`);
  }

  function concat(parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  function encodeBedrockEvent(event: BedrockStreamEvent): Uint8Array | null {
    const e = event as Loose;

    if (e.messageStart) {
      rolePrepended = true;
      return sse(envelope({ role: "assistant" }));
    }

    if (e.contentBlockStart) {
      const start = e.contentBlockStart.start;
      if (start?.toolUse) {
        const idx = nextToolIndex++;
        toolIndexByBlock.set(e.contentBlockStart.contentBlockIndex, idx);
        return sse(
          envelope({
            tool_calls: [
              {
                index: idx,
                id: String(start.toolUse.toolUseId ?? ""),
                type: "function",
                function: {
                  name: String(start.toolUse.name ?? ""),
                  arguments: "",
                },
              },
            ],
          }),
        );
      }
      return null;
    }

    if (e.contentBlockDelta) {
      const delta = e.contentBlockDelta.delta;
      if (typeof delta?.text === "string") {
        return sse(envelope({ content: delta.text }));
      }
      if (delta?.toolUse && typeof delta.toolUse.input === "string") {
        const blockIdx = e.contentBlockDelta.contentBlockIndex;
        const toolIdx =
          toolIndexByBlock.get(blockIdx) ?? Math.max(0, nextToolIndex - 1);
        return sse(
          envelope({
            tool_calls: [
              {
                index: toolIdx,
                function: { arguments: delta.toolUse.input },
              },
            ],
          }),
        );
      }
      return null;
    }

    if (e.contentBlockStop) {
      return null;
    }

    if (e.messageStop) {
      pendingFinishReason = mapStopReason(e.messageStop.stopReason);
      return null;
    }

    if (e.metadata?.usage && ctx.includeUsageInStream) {
      const u = e.metadata.usage;
      const prompt = Number(u.inputTokens ?? 0);
      const completion = Number(u.outputTokens ?? 0);
      return sse({
        id: ctx.chatcmplId,
        object: "chat.completion.chunk",
        created: ctx.createdUnix,
        model: ctx.requestedModel,
        choices: [],
        usage: {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: Number(u.totalTokens ?? prompt + completion),
        },
      });
    }

    return null;
  }

  function formatEnd(): Uint8Array {
    const parts: Uint8Array[] = [];
    if (pendingFinishReason !== null) {
      parts.push(sse(envelope({}, pendingFinishReason)));
      pendingFinishReason = null;
    }
    parts.push(ENCODER.encode("data: [DONE]\n\n"));
    return concat(parts);
  }

  function formatTextDelta(text: string): Uint8Array {
    const parts: Uint8Array[] = [];
    if (!rolePrepended) {
      parts.push(sse(envelope({ role: "assistant" })));
      rolePrepended = true;
    }
    parts.push(sse(envelope({ content: text })));
    return concat(parts);
  }

  function formatCompleteText(text: string): Uint8Array[] {
    // A self-contained "refusal" response. Always use finish_reason:"stop",
    // discarding any pending reason from a prior messageStop.
    pendingFinishReason = null;
    rolePrepended = true;
    return [
      sse(envelope({ role: "assistant" })),
      sse(envelope({ content: text })),
      sse(envelope({}, "stop")),
    ];
  }

  function buildFinalResponseFromState(
    state: StreamAccumulatorState,
  ): OpenAiResponse {
    const toolCalls = state.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));
    const usage = {
      prompt_tokens: state.usage?.inputTokens ?? 0,
      completion_tokens: state.usage?.outputTokens ?? 0,
      total_tokens:
        (state.usage?.inputTokens ?? 0) + (state.usage?.outputTokens ?? 0),
    };
    return {
      id: ctx.chatcmplId,
      object: "chat.completion",
      created: ctx.createdUnix,
      model: ctx.requestedModel,
      choices: [
        {
          index: 0,
          logprobs: null,
          finish_reason: mapStopReason(state.stopReason ?? undefined),
          message: {
            role: "assistant",
            content: state.text || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
        },
      ],
      usage,
    } as OpenAiResponse;
  }

  return {
    encodeBedrockEvent,
    formatEnd,
    formatTextDelta,
    formatCompleteText,
    buildFinalResponseFromState,
  };
}

/** Generate a fresh OpenAI-style chat completion id. */
export function newChatcmplId(): string {
  return `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

// =============================================================================
// internal helpers
// =============================================================================

function stringifyAssistantText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        const part = p as Loose;
        if (part?.type === "text") return String(part.text ?? "");
        // refusal parts: treat refusal text as the assistant text
        if (part?.type === "refusal") return String(part.refusal ?? "");
        return "";
      })
      .join("");
  }
  return "";
}

function userContentToBedrock(content: unknown): BedrockContentBlock[] {
  if (typeof content === "string") {
    return [{ text: content }];
  }
  if (!Array.isArray(content)) return [];
  const out: BedrockContentBlock[] = [];
  for (const part of content as Loose[]) {
    if (part?.type === "text") {
      out.push({ text: String(part.text ?? "") });
    } else if (part?.type === "image_url") {
      const url = String(part.image_url?.url ?? "");
      out.push(imageFromDataUrl(url) as BedrockContentBlock);
    }
  }
  return out;
}

function imageFromDataUrl(url: string): unknown {
  const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/i.exec(url);
  if (!m) {
    throw new Error(
      `image_url must be a base64 data URL (data:image/...;base64,...) — got "${url.slice(0, 40)}..."`,
    );
  }
  const fmt = m[1].toLowerCase() === "jpg" ? "jpeg" : m[1].toLowerCase();
  return { image: { format: fmt, source: { bytes: m[2] } } };
}

function toolResultContent(content: unknown): Loose[] {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: "" }];
  const out: Loose[] = [];
  for (const part of content as Loose[]) {
    if (part?.type === "text") {
      out.push({ text: String(part.text ?? "") });
    } else if (part?.type === "image_url") {
      const url = String(part.image_url?.url ?? "");
      out.push(imageFromDataUrl(url));
    }
  }
  return out.length > 0 ? out : [{ text: "" }];
}

function buildInferenceConfig(loose: Loose): BedrockRequest["inferenceConfig"] {
  const cfg: NonNullable<BedrockRequest["inferenceConfig"]> = {};
  if (typeof loose.temperature === "number")
    cfg.temperature = loose.temperature;
  if (typeof loose.top_p === "number") cfg.topP = loose.top_p;
  if (typeof loose.max_tokens === "number") cfg.maxTokens = loose.max_tokens;
  if (typeof loose.stop === "string") cfg.stopSequences = [loose.stop];
  else if (Array.isArray(loose.stop))
    cfg.stopSequences = loose.stop.map(String);
  return Object.keys(cfg).length > 0 ? cfg : undefined;
}

function buildToolConfig(
  loose: Loose,
): BedrockRequest["toolConfig"] | undefined {
  const toolChoice = loose.tool_choice;
  if (toolChoice === "none") return undefined;

  const tools = Array.isArray(loose.tools) ? loose.tools : [];
  if (tools.length === 0 && toolChoice == null) return undefined;

  const mapped = tools
    .filter((t: Loose) => t?.type === "function" && t.function?.name)
    .map((t: Loose) => ({
      toolSpec: {
        name: String(t.function.name),
        ...(t.function.description
          ? { description: String(t.function.description) }
          : {}),
        inputSchema: {
          json: (t.function.parameters ?? {
            type: "object",
            properties: {},
          }) as Record<string, unknown>,
        },
      },
    }));

  const cfg: NonNullable<BedrockRequest["toolConfig"]> = { tools: mapped };

  if (toolChoice === "auto") cfg.toolChoice = { auto: {} };
  else if (toolChoice === "required") cfg.toolChoice = { any: {} };
  else if (
    toolChoice &&
    typeof toolChoice === "object" &&
    toolChoice.type === "function" &&
    toolChoice.function?.name
  ) {
    cfg.toolChoice = { tool: { name: String(toolChoice.function.name) } };
  }

  return cfg;
}
