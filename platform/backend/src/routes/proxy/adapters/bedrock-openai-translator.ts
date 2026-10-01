import { randomUUID } from "node:crypto";
import { ApiError } from "@archestra/shared";
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import type { Bedrock, OpenAi, StreamAccumulatorState } from "@/types";
import type { OpenAiStreamUsage } from "./openai-sse-chunk";
import { parseJsonObject } from "./openai-translator-utils";

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
  const system: NonNullable<BedrockRequest["system"]> = [];
  const messages: BedrockMessage[] = [];

  for (const m of req.messages ?? []) {
    const role = (m as Loose).role as string;
    if (role === "system" || role === "developer") {
      const blocks = textContentToBedrock((m as Loose).content);
      appendCacheMarker(blocks, (m as Loose).cache_control);
      system.push(...blocks);
      continue;
    }

    if (role === "user") {
      const content = ensureBedrockUserContentHasText(
        userContentToBedrock((m as Loose).content),
      );
      appendCacheMarker(content, (m as Loose).cache_control);
      messages.push({ role: "user", content });
      continue;
    }

    if (role === "assistant") {
      const content = textContentToBedrock((m as Loose).content);
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
      appendCacheMarker(content, (m as Loose).cache_control);
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
      const blocks: BedrockContentBlock[] = [block];
      // Tool result markers belong after the enclosing toolResult union block.
      if (Array.isArray((m as Loose).content)) {
        for (const part of (m as Loose).content)
          appendCacheMarker(blocks, part?.cache_control);
      }
      appendCacheMarker(blocks, (m as Loose).cache_control);
      const prev = messages[messages.length - 1];
      if (prev && prev.role === "user") {
        prev.content.push(...blocks);
      } else {
        messages.push({
          role: "user",
          content: blocks,
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
  const usage = converseUsageToOpenai({
    uncachedInputTokens: resp.usage?.inputTokens ?? 0,
    outputTokens: resp.usage?.outputTokens ?? 0,
    cacheReadTokens: resp.usage?.cacheReadInputTokens ?? 0,
    cacheWriteTokens: resp.usage?.cacheWriteInputTokens ?? 0,
    cacheWrite1hTokens: (resp.usage?.cacheDetails ?? [])
      .filter((d) => d.ttl === "1h")
      .reduce((sum, d) => sum + (d.inputTokens ?? 0), 0),
  });

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

/**
 * Map Bedrock Converse token counts onto the OpenAI usage fields.
 *
 * Converse reports `inputTokens` as the prompt tokens that MISSED the cache —
 * `cacheReadInputTokens` and `cacheWriteInputTokens` are counted alongside it,
 * not inside it (which is why `totalTokens` exceeds inputTokens + outputTokens
 * on a cached turn). OpenAI's `prompt_tokens` is the gross prompt count, with
 * cache hits repeated as a subset in `prompt_tokens_details.cached_tokens`, so
 * forwarding `inputTokens` straight across drops the cached prefix: a Claude
 * turn on Bedrock that reads 90k tokens back from the cache reports a prompt of
 * only the few tokens that missed.
 *
 * Takes already-extracted counts because the three call sites read them from
 * three different shapes (`ConverseResponse.usage`, the stream's metadata
 * event, and the accumulator's `UsageView`) that agree on the semantics but not
 * on the field names.
 */
function converseUsageToOpenai(params: {
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens?: number;
}): OpenAiStreamUsage {
  const promptTokens =
    params.uncachedInputTokens +
    params.cacheReadTokens +
    params.cacheWriteTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: params.outputTokens,
    total_tokens: promptTokens + params.outputTokens,
    // Omitted rather than zeroed when nothing was cached, so the field's
    // presence still means "this provider reported cache hits".
    ...(params.cacheReadTokens > 0 || params.cacheWriteTokens > 0
      ? {
          prompt_tokens_details: {
            cached_tokens: params.cacheReadTokens,
            ...(params.cacheWriteTokens > 0
              ? { cache_write_tokens: params.cacheWriteTokens }
              : {}),
            ...(params.cacheWrite1hTokens
              ? { cache_write_1h_tokens: params.cacheWrite1hTokens }
              : {}),
          },
        }
      : {}),
  };
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
  /**
   * The turn's tool calls as one complete OpenAI tool_calls delta chunk, for
   * the proxy's dispatch-mode repair (see `planDispatchModeToolCallRewrites`).
   * The finish reason stays held for formatEnd, as for a live tool call.
   */
  formatToolCalls(toolCalls: StreamAccumulatorState["toolCalls"]): Uint8Array[];
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
      return sse({
        id: ctx.chatcmplId,
        object: "chat.completion.chunk",
        created: ctx.createdUnix,
        model: ctx.requestedModel,
        choices: [],
        usage: converseUsageToOpenai({
          uncachedInputTokens: Number(u.inputTokens ?? 0),
          outputTokens: Number(u.outputTokens ?? 0),
          cacheReadTokens: Number(u.cacheReadInputTokens ?? 0),
          cacheWriteTokens: Number(u.cacheWriteInputTokens ?? 0),
          cacheWrite1hTokens: (u.cacheDetails ?? [])
            .filter((d: Loose) => d.ttl === "1h")
            .reduce((sum: number, d: Loose) => sum + (d.inputTokens ?? 0), 0),
        }),
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

  function formatToolCalls(
    toolCalls: StreamAccumulatorState["toolCalls"],
  ): Uint8Array[] {
    const parts: Uint8Array[] = [];
    if (!rolePrepended) {
      parts.push(sse(envelope({ role: "assistant" })));
      rolePrepended = true;
    }
    parts.push(
      sse(
        envelope({
          tool_calls: toolCalls.map((toolCall, index) => ({
            index,
            id: toolCall.id,
            type: "function",
            function: { name: toolCall.name, arguments: toolCall.arguments },
          })),
        }),
      ),
    );
    return parts;
  }

  function buildFinalResponseFromState(
    state: StreamAccumulatorState,
  ): OpenAiResponse {
    const toolCalls = state.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));
    const usage = converseUsageToOpenai({
      uncachedInputTokens: state.usage?.inputTokens ?? 0,
      outputTokens: state.usage?.outputTokens ?? 0,
      cacheReadTokens: state.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: state.usage?.cacheWriteTokens ?? 0,
      cacheWrite1hTokens: state.usage?.cacheWrite1hTokens,
    });
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
    formatToolCalls,
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

function textContentToBedrock(content: unknown): BedrockContentBlock[] {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: Loose) => {
    if (part?.type !== "text" && part?.type !== "refusal") {
      if (part?.cache_control !== undefined)
        throw new ApiError(
          400,
          "Unsupported Bedrock content part with cache_control",
        );
      return [];
    }
    const text = String(part.text ?? part.refusal ?? "");
    const blocks: BedrockContentBlock[] = text ? [{ text }] : [];
    appendCacheMarker(blocks, part?.cache_control);
    return blocks;
  });
}

function appendCacheMarker(blocks: BedrockContentBlock[], marker: Loose): void {
  if (marker === undefined) return;
  if (
    !marker ||
    marker.type !== "ephemeral" ||
    (marker.ttl !== undefined && typeof marker.ttl !== "string")
  )
    throw new ApiError(
      400,
      "Bedrock cache_control requires type ephemeral and an optional string ttl",
    );
  // Model support, TTLs, checkpoint limits and ordering are validated by AWS.
  blocks.push({
    cachePoint: {
      type: "default",
      ...(marker.ttl !== undefined ? { ttl: marker.ttl } : {}),
    },
  });
}

// MIMEs whose text content Bedrock's document block can represent as txt.
const BEDROCK_NORMALIZE_TO_TEXT_PLAIN = new Set([
  "application/json",
  "application/csv",
]);

// Bedrock-supported document MIME → Converse document format.
// Kept in sync with the AI SDK's own BEDROCK_DOCUMENT_MIME_TYPES so the proxy
// accepts the same set the SDK can relay downstream.
const BEDROCK_DOCUMENT_FORMATS: Record<string, string> = {
  "application/pdf": "pdf",
  "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/html": "html",
  "text/plain": "txt",
  "text/markdown": "md",
};

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
      const block = imageUrlToBlock(url);
      out.push(block as BedrockContentBlock);
    } else if (part?.type === "file") {
      const file = part.file;
      out.push(fileDataToBlock(file) as BedrockContentBlock);
    } else {
      if (part?.cache_control !== undefined)
        throw new ApiError(
          400,
          "Unsupported Bedrock content part with cache_control",
        );
      continue;
    }
    appendCacheMarker(out, part.cache_control);
  }
  return out;
}

// Bedrock rejects user messages that contain a document block but no text block.
// Prepend a placeholder so document-only OpenAI messages are accepted.
function ensureBedrockUserContentHasText(
  content: BedrockContentBlock[],
): BedrockContentBlock[] {
  const hasText = content.some((b) => "text" in b && b.text.trim().length > 0);
  const hasDocument = content.some((b) => "document" in b);
  if (hasDocument && !hasText) {
    return [
      { text: "Please review the attached document." } as BedrockContentBlock,
      ...content,
    ];
  }
  return content;
}

function fileDataToBlock(file: Loose): unknown {
  if (
    !file ||
    file.file_id ||
    file.file_url ||
    typeof file.file_data !== "string"
  )
    throw new ApiError(
      400,
      "Bedrock files require inline base64 file_data; file IDs and URLs cannot be resolved",
    );
  if (file.file_data.startsWith("data:"))
    return imageUrlToBlock(file.file_data);
  const extension =
    typeof file.filename === "string"
      ? file.filename.split(".").at(-1)?.toLowerCase()
      : undefined;
  const mime =
    extension === "json"
      ? "application/json"
      : Object.entries(BEDROCK_DOCUMENT_FORMATS).find(
          ([, format]) => format === extension,
        )?.[0];
  if (!mime || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.file_data))
    throw new ApiError(
      400,
      "Bedrock file_data must be a base64 data URL or base64 bytes with a supported filename extension",
    );
  return imageUrlToBlock(`data:${mime};base64,${file.file_data}`);
}

// Routes an image_url data URL to the correct Bedrock content block.
// Inline data only: external URLs and unresolved files must never disappear.
function imageUrlToBlock(url: string): unknown {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(url);
  if (!m)
    throw new ApiError(
      400,
      "Bedrock image and file inputs require a base64 data URL with a supported MIME type",
    );

  const rawMime = m[1].toLowerCase();
  const bytes = m[2];

  const imageFormats: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/jpg": "jpeg",
    "image/gif": "gif",
    "image/webp": "webp",
  };
  if (imageFormats[rawMime]) {
    return { image: { format: imageFormats[rawMime], source: { bytes } } };
  }

  const effectiveMime = BEDROCK_NORMALIZE_TO_TEXT_PLAIN.has(rawMime)
    ? "text/plain"
    : rawMime;
  const docFormat = BEDROCK_DOCUMENT_FORMATS[effectiveMime];
  if (docFormat) {
    return {
      document: { format: docFormat, name: "document", source: { bytes } },
    };
  }

  throw new ApiError(400, "Unsupported Bedrock image or document MIME type");
}

function toolResultContent(content: unknown): Loose[] {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: "" }];
  const out: Loose[] = [];
  for (const [index, part] of content.entries()) {
    if (part?.cache_control !== undefined && index !== content.length - 1)
      throw new ApiError(
        400,
        "A Bedrock tool-result cache marker must follow the complete tool result",
      );
    if (part?.type === "text") out.push({ text: String(part.text ?? "") });
    else if (part?.type === "image_url")
      out.push(imageUrlToBlock(String(part.image_url?.url ?? "")));
    else if (part?.type === "file") out.push(fileDataToBlock(part.file));
    else if (
      part?.type === "json" &&
      part.json &&
      typeof part.json === "object"
    )
      out.push({ json: part.json });
    else if (part?.cache_control !== undefined)
      throw new ApiError(
        400,
        "Unsupported Bedrock tool-result content part with cache_control",
      );
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
