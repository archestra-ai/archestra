import { randomUUID } from "node:crypto";
import {
  type GeminiThinkingLevel,
  supportsGeminiThinkingEffort,
} from "@archestra/shared/gemini-models";
import { ApiError } from "@archestra/shared/types";
import type { Gemini, OpenAi, UsageView } from "@/types";
import { UpstreamStreamIncompleteError } from "@/utils/upstream-stream-incomplete-error";
import { assertUnstructuredResponseFormat } from "../translated-response-format";
import { sanitizeGeminiToolSchema } from "./gemini-schema";
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
type GeminiRequest = Gemini.Types.GenerateContentRequest & {
  _model?: string;
  _isStreaming?: boolean;
};
type GeminiResponse = Gemini.Types.GenerateContentResponse;

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

export interface GeminiOpenaiContext {
  chatcmplId: string;
  createdUnix: number;
  requestedModel: string;
}

export function openaiToGemini(req: OpenAiRequest): {
  geminiBody: GeminiRequest;
  openaiContext: GeminiOpenaiContext;
} {
  assertUnstructuredResponseFormat(req, "the Gemini translation");
  const output = req as OpenAiRequest & {
    modalities?: string[];
    audio?: unknown;
  };
  if (
    output.audio !== undefined ||
    output.modalities?.some((modality) => modality !== "text")
  )
    throw new ApiError(400, "Gemini translation supports only text output");
  if (req.tools?.some((tool) => tool.type !== "function"))
    throw new ApiError(400, "Gemini translation supports only function tools");
  const loose = req as OpenAiRequest & {
    stop?: string | string[] | null;
    top_p?: number | null;
    cachedContent?: string;
  };
  const systemParts: Array<{ text: string }> = [];
  const contents: GeminiRequest["contents"] = [];

  // Gemini 3 validates that a functionResponse's name matches the function
  // that was called; OpenAI tool messages carry only tool_call_id, so the
  // names are resolved from the assistant messages' tool_calls.
  const toolCallNames = new Map<string, string>();
  for (const message of req.messages as LooseMessage[]) {
    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall.type === "function" && toolCall.id) {
        toolCallNames.set(toolCall.id, toolCall.function.name);
      }
    }
  }

  for (const message of req.messages as LooseMessage[]) {
    if (message.role === "system" || message.role === "developer") {
      systemParts.push({ text: stringifyTextContent(message.content) });
      continue;
    }

    if (message.role === "user") {
      const parts = userContentToGeminiParts(message.content);
      const previous = contents[contents.length - 1];
      if (
        previous?.role === "user" &&
        previous.parts.some((part) => "functionResponse" in part)
      ) {
        previous.parts.push(...parts);
        continue;
      }
      contents.push({
        // Gemini rejects a content entry with no parts; keep an empty text
        // part for messages that carried no convertible content.
        role: "user",
        parts: parts.length > 0 ? parts : [{ text: "" }],
      });
      continue;
    }

    if (message.role === "assistant") {
      const parts: Gemini.Types.MessagePart[] = [];
      const text = stringifyTextContent(message.content);
      if (text) {
        parts.push({ text });
      }
      for (const toolCall of message.tool_calls ?? []) {
        if (toolCall.type !== "function") continue;
        const signed = decodeSignedToolCallId(toolCall.id);
        parts.push({
          functionCall: {
            id: signed.id,
            name: toolCall.function.name,
            args: parseJsonObject(toolCall.function.arguments),
          },
          thoughtSignature:
            signed.thoughtSignature ?? FOREIGN_THOUGHT_SIGNATURE,
        });
      }
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    if (message.role === "tool") {
      // Keep inline tool images/files as sibling parts, alongside the JSON
      // result. Every result in a parallel batch stays in this same user turn.
      const functionResponsePart = {
        functionResponse: {
          id: decodeSignedToolCallId(message.tool_call_id).id,
          // Resolved from the assistant turn that made the call; Gemini 3
          // rejects a functionResponse whose name does not match it. The
          // synthetic fallback only covers a result with no visible call.
          name:
            (message.tool_call_id
              ? toolCallNames.get(message.tool_call_id)
              : undefined) ?? "tool_result",
          response: { content: stringifyTextContent(message.content) },
        },
      };
      // Parallel tool calls arrive as one assistant turn with N tool_calls
      // followed by N separate tool messages. Gemini requires all N
      // functionResponse parts in ONE user turn — it rejects the history when
      // the response-part count does not match the call turn — so consecutive
      // tool results fold into the same entry.
      const previous = contents[contents.length - 1];
      if (
        previous?.role === "user" &&
        previous.parts.some((part) => "functionResponse" in part)
      ) {
        const firstMedia = previous.parts.findIndex(
          (part) => !("functionResponse" in part),
        );
        previous.parts.splice(
          firstMedia < 0 ? previous.parts.length : firstMedia,
          0,
          functionResponsePart,
        );
      } else {
        contents.push({ role: "user", parts: [functionResponsePart] });
      }
      const media = normalizeOpenAiContentParts(message.content, {
        rejectUnsupported: true,
      })
        .filter((part) => part.kind !== "text")
        .map((part) => {
          const translated = normalizedPartToGeminiPart(part);
          if (!translated)
            throw new ApiError(
              400,
              "Gemini tool results require inline media; remote URLs cannot be translated",
            );
          return translated;
        });
      contents[contents.length - 1].parts.push(...media);
    }
  }

  ensureTrailingUserTurn(contents);

  const geminiBody: GeminiRequest = {
    contents,
    _model: req.model,
    _isStreaming: req.stream === true,
  };

  if (loose.cachedContent !== undefined)
    geminiBody.cachedContent = loose.cachedContent;

  if (systemParts.length > 0) {
    geminiBody.systemInstruction = { parts: systemParts };
  }

  const thinkingConfig = openaiEffortToGeminiThinkingConfig(
    req.model,
    req.reasoning_effort,
  );
  const maxOutputTokens = req.max_completion_tokens ?? req.max_tokens;
  if (
    req.temperature !== undefined ||
    req.max_tokens !== undefined ||
    req.max_completion_tokens !== undefined ||
    thinkingConfig !== undefined ||
    loose.top_p !== undefined ||
    loose.stop !== undefined
  ) {
    geminiBody.generationConfig = {};
    if (req.temperature !== undefined && req.temperature !== null) {
      geminiBody.generationConfig.temperature = req.temperature;
    }
    if (maxOutputTokens !== undefined && maxOutputTokens !== null) {
      geminiBody.generationConfig.maxOutputTokens = maxOutputTokens;
    }
    if (thinkingConfig !== undefined) {
      geminiBody.generationConfig.thinkingConfig = thinkingConfig;
    }
    if (loose.top_p !== undefined && loose.top_p !== null) {
      geminiBody.generationConfig.topP = loose.top_p;
    }
    if (loose.stop !== undefined && loose.stop !== null) {
      geminiBody.generationConfig.stopSequences = Array.isArray(loose.stop)
        ? loose.stop
        : [loose.stop];
    }
  }

  if (req.tools) {
    geminiBody.tools = [
      {
        functionDeclarations: req.tools
          .filter((tool) => tool.type === "function")
          .map((tool) => ({
            name: tool.function.name,
            description: tool.function.description ?? "",
            // Gemini rejects non-string enums; same sanitizer the native Gemini
            // adapter applies, shared so this OpenAI-compatible path can't 400.
            parameters: sanitizeGeminiToolSchema(
              tool.function.parameters,
            ) as typeof tool.function.parameters,
          })),
      },
    ];
  }

  if (req.tool_choice) {
    geminiBody.toolConfig = {
      functionCallingConfig: {
        mode: toGeminiToolChoice(req.tool_choice),
      },
    };
  }

  return {
    geminiBody,
    openaiContext: {
      chatcmplId: `chatcmpl-${randomUUID()}`,
      createdUnix: Math.floor(Date.now() / 1000),
      requestedModel: req.model,
    },
  };
}

// OpenAI compatibility uses different effort semantics from internal Chat's
// depth selector: low stays low on Gemini 3, and 2.5 uses token budgets.
// https://ai.google.dev/gemini-api/docs/openai#thinking
function openaiEffortToGeminiThinkingConfig(
  modelId: string,
  effort: OpenAiRequest["reasoning_effort"],
):
  | { thinkingBudget: number }
  | { thinkingLevel: GeminiThinkingLevel }
  | undefined {
  if (effort === undefined || effort === null) return undefined;

  // Identify documented exceptions, including their dated/preview aliases.
  // New families use the shared text/version rules and provider validation.
  const family = modelId
    .toLowerCase()
    .match(
      /^(gemini-\d+(?:\.\d+)?-(?:flash-lite|flash|pro))(?:-(?:preview(?:-(?:customtools|\d[\d-]*))?|latest|\d[\d-]*))?$/,
    )?.[1];
  const unsupported = () =>
    new ApiError(
      400,
      `reasoning_effort "${effort}" is not supported for model "${modelId}".`,
    );
  if (effort === "xhigh" || effort === "max") throw unsupported();
  if (effort === "none") {
    if (family === "gemini-2.5-flash" || family === "gemini-2.5-flash-lite") {
      return { thinkingBudget: 0 };
    }
    throw unsupported();
  }
  if (family?.startsWith("gemini-2.5-")) {
    return {
      thinkingBudget: { minimal: 1024, low: 1024, medium: 8192, high: 24576 }[
        effort
      ],
    };
  }

  if (!supportsGeminiThinkingEffort(modelId)) throw unsupported();
  if (
    (effort === "medium" && family === "gemini-3-pro") ||
    (effort === "minimal" &&
      (family === "gemini-3.7-flash" || family === "gemini-3.8-flash"))
  ) {
    throw unsupported();
  }
  const thinkingLevel =
    effort === "minimal" &&
    (family === "gemini-3-pro" || family === "gemini-3.1-pro")
      ? "low"
      : effort;
  return { thinkingLevel };
}

/**
 * Same mapping as `geminiUsageToOpenai`, but from the stream accumulator.
 *
 * The accumulator normalizes `inputTokens` to *uncached* input and keeps the
 * cache and thinking counts alongside, so the gross figures OpenAI's wire
 * format expects are reassembled here: `prompt_tokens` adds the cache reads
 * back, and `completion_tokens` includes the thinking tokens Gemini reports
 * separately from `candidatesTokenCount`. The details expose that subset.
 *
 * Reading the accumulator rather than the streamed adapter's rebuilt response
 * is deliberate: that rebuild reports `promptTokenCount` net of cache, so it
 * cannot be the source of truth for the gross number.
 */
export function geminiUsageViewToOpenai(
  usage: UsageView | null | undefined,
): OpenAiStreamUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const promptTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0);
  const reasoningTokens = usage.reasoningTokens ?? 0;
  const completionTokens = usage.outputTokens + reasoningTokens;
  return {
    prompt_tokens: promptTokens,
    ...((usage.cacheReadTokens ?? 0) > 0
      ? { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens ?? 0 } }
      : {}),
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    ...(reasoningTokens > 0
      ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } }
      : {}),
  };
}

/**
 * Map Gemini's `usageMetadata` onto the OpenAI usage fields.
 *
 * Deliberately reads the raw metadata rather than the stream accumulator's
 * `UsageView`: that view normalizes `inputTokens` to *uncached* input
 * (`promptTokenCount - cachedContentTokenCount`, see the gemini adapter), while
 * OpenAI's `prompt_tokens` is the gross prompt count. Going through the view
 * would make a streamed turn report a smaller prompt — and a smaller total,
 * since `totalTokenCount` also counts thinking tokens — than the non-streaming
 * reply for the identical request on the same route.
 */
export function geminiUsageToOpenai(
  response: GeminiResponse,
): OpenAiStreamUsage {
  const promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
  const reasoningTokens = response.usageMetadata?.thoughtsTokenCount ?? 0;
  const completionTokens =
    (response.usageMetadata?.candidatesTokenCount ?? 0) + reasoningTokens;
  return {
    prompt_tokens: promptTokens,
    ...((response.usageMetadata?.cachedContentTokenCount ?? 0) > 0
      ? {
          prompt_tokens_details: {
            cached_tokens: response.usageMetadata?.cachedContentTokenCount ?? 0,
          },
        }
      : {}),
    completion_tokens: completionTokens,
    total_tokens:
      response.usageMetadata?.totalTokenCount ??
      promptTokens + completionTokens,
    ...(reasoningTokens > 0
      ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } }
      : {}),
  };
}

export function geminiResponseToOpenai(
  response: GeminiResponse,
  ctx: GeminiOpenaiContext,
): OpenAiResponse {
  const candidate = response.candidates?.[0];
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];
  let text = "";

  // Blocked candidates carry a `finishReason` but no `content`.
  for (const part of candidate?.content?.parts ?? []) {
    if ("text" in part && part.text && !part.thought) {
      text += part.text;
      continue;
    }
    if ("functionCall" in part && part.functionCall) {
      toolCalls.push({
        id: encodeSignedToolCallId({
          id: part.functionCall.id,
          name: part.functionCall.name,
          thoughtSignature:
            "thoughtSignature" in part ? part.thoughtSignature : undefined,
        }),
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    }
  }

  const usage = geminiUsageToOpenai(response);

  // A prompt-blocked reply carries only `promptFeedback` — no candidates, so no
  // `finishReason` to map. Without this branch it would report a plain "stop"
  // and the client would see an empty completion with no sign it was filtered.
  const promptBlockReason = response.promptFeedback?.blockReason;
  const promptBlocked =
    candidate === undefined &&
    promptBlockReason !== undefined &&
    promptBlockReason !== "BLOCK_REASON_UNSPECIFIED";

  let finishReason = mapGeminiFinishReason(candidate?.finishReason);
  if (toolCalls.length > 0) {
    finishReason = "tool_calls";
  } else if (promptBlocked) {
    finishReason = "content_filter";
  }

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

export function mapGeminiFinishReason(
  reason: Gemini.Types.FinishReason | null | undefined,
): "stop" | "length" | "tool_calls" | "content_filter" {
  if (reason === "MAX_TOKENS") return "length";
  if (
    reason === "MALFORMED_FUNCTION_CALL" ||
    reason === "TOO_MANY_TOOL_CALLS"
  ) {
    return "tool_calls";
  }

  if (reason && reason !== "STOP") return "content_filter";
  return "stop";
}

/**
 * Gemini 3 rejects conversation history whose functionCall parts lack the
 * thoughtSignature they were produced with. The OpenAI chat wire format has
 * no field to carry one, but clients echo tool-call ids verbatim — so the
 * signature rides inside the id on the way to the client and is unpacked
 * (and stripped) on the way back upstream.
 */
export function encodeSignedToolCallId(params: {
  id: string | undefined;
  name: string | undefined;
  thoughtSignature: string | undefined;
}): string {
  const base = params.id ?? `gemini-call-${params.name ?? "fn"}-${Date.now()}`;
  if (!params.thoughtSignature) {
    return base;
  }
  const encoded = Buffer.from(params.thoughtSignature, "utf8").toString(
    "base64url",
  );
  return `${SIGNED_TOOL_CALL_ID_PREFIX}${encoded}.${base}`;
}

export function decodeSignedToolCallId(id: string | undefined): {
  id: string | undefined;
  thoughtSignature: string | undefined;
} {
  if (!id?.startsWith(SIGNED_TOOL_CALL_ID_PREFIX)) {
    return { id, thoughtSignature: undefined };
  }
  const rest = id.slice(SIGNED_TOOL_CALL_ID_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot < 0) {
    return { id, thoughtSignature: undefined };
  }
  try {
    return {
      id: rest.slice(dot + 1),
      thoughtSignature: Buffer.from(rest.slice(0, dot), "base64url").toString(
        "utf8",
      ),
    };
  } catch {
    return { id, thoughtSignature: undefined };
  }
}

const SIGNED_TOOL_CALL_ID_PREFIX = "gemsig-";

// Gemini rejects a generateContent request whose `contents` ends with a
// `model` turn ("Requests ending with a model turn are not supported."), but
// the OpenAI wire contract permits a trailing assistant message: clients send
// one to continue a turn, and an aborted tool loop resurfaces an assistant
// tool_calls turn whose tool results were never attached. Repair both shapes
// so the translated request stays servable — each unanswered trailing
// functionCall gets a synthetic functionResponse (id and name copied from the
// call, which Gemini 3 validates against it), and a text-only trailing model
// turn is followed by the same minimal user turn the chat-side leading-turn
// repair uses (prepare-model-messages.ts).
const TRAILING_USER_TURN_TEXT = "Continue.";
const INTERRUPTED_TOOL_RESULT_TEXT =
  "Tool execution was interrupted before it produced a result. The tool did not run; do not assume it did.";

function ensureTrailingUserTurn(contents: GeminiRequest["contents"]): void {
  const last = contents[contents.length - 1];
  if (!last || last.role === "user") {
    return;
  }

  const responseParts: Gemini.Types.MessagePart[] = [];
  for (const part of last.parts) {
    if ("functionCall" in part && part.functionCall) {
      responseParts.push({
        functionResponse: {
          id: part.functionCall.id,
          name: part.functionCall.name,
          response: { content: INTERRUPTED_TOOL_RESULT_TEXT },
        },
      });
    }
  }

  contents.push(
    responseParts.length > 0
      ? { role: "user", parts: responseParts }
      : { role: "user", parts: [{ text: TRAILING_USER_TURN_TEXT }] },
  );
}

function toGeminiToolChoice(
  toolChoice: OpenAiRequest["tool_choice"],
): "AUTO" | "ANY" | "NONE" {
  if (toolChoice === "required") return "ANY";
  if (toolChoice === "none") return "NONE";
  return "AUTO";
}

// Converts an OpenAI user-message `content` into Gemini parts, preserving
// images/files/audio instead of dropping every non-text part.
function userContentToGeminiParts(
  content: unknown,
): Gemini.Types.MessagePart[] {
  const parts: Gemini.Types.MessagePart[] = [];
  for (const part of normalizeOpenAiContentParts(content, {
    rejectUnsupported: true,
  })) {
    const geminiPart = normalizedPartToGeminiPart(part);
    if (geminiPart) parts.push(geminiPart);
  }
  return parts;
}

// Maps one normalized content part to a Gemini part. Only inline base64 data
// URLs are forwarded (as `inlineData`). Refuse remote images/files rather than
// silently discarding them or fetching arbitrary URLs inside the proxy.
function normalizedPartToGeminiPart(
  part: NormalizedContentPart,
): Gemini.Types.MessagePart | null {
  switch (part.kind) {
    case "text":
      return { text: part.text };
    case "image": {
      const inline = parseDataUrl(part.url);
      if (inline) {
        return { inlineData: { mimeType: inline.mimeType, data: inline.data } };
      }
      throw new ApiError(
        400,
        "Gemini translation requires inline images; remote URLs cannot be translated",
      );
    }
    case "audio":
      return {
        inlineData: { mimeType: `audio/${part.format}`, data: part.data },
      };
    case "file": {
      const inline = parseDataUrl(part.fileData);
      if (inline) {
        return { inlineData: { mimeType: inline.mimeType, data: inline.data } };
      }
      throw new ApiError(400, "Gemini translation requires inline files");
    }
  }
}

function unsupported(feature: string): never {
  throw new ApiError(
    400,
    `Gemini cross-provider model pools cannot translate ${feature}. Use a Gemini-only pool for this request.`,
  );
}

/** Gemini's documented marker for history produced by a non-Gemini model.
 * Only attach it to newly translated calls; never replace a Gemini signature.
 * https://cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures
 */
const FOREIGN_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

/** Adapt the portable conversation to the existing OpenAI pool transports. */
export function geminiToOpenai(
  req: GeminiRequest,
): OpenAi.Types.ChatCompletionsRequest {
  if (req.cachedContent) unsupported("cachedContent");
  if (req.safetySettings?.length) unsupported("safetySettings");
  const config = req.generationConfig ?? {};
  const portable = new Set([
    "maxOutputTokens",
    "temperature",
    "topP",
    "stopSequences",
    "thinkingConfig",
  ]);
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || portable.has(key)) continue;
    if (key === "candidateCount" && value === 1) continue;
    if (key === "responseMimeType" && value === "text/plain") continue;
    if (
      key === "responseModalities" &&
      Array.isArray(value) &&
      value.every((v) => v === "TEXT")
    )
      continue;
    unsupported(`generationConfig.${key}`);
  }
  const messages: LooseMessage[] = [];
  if (req.systemInstruction)
    messages.push({
      role: "system",
      content: req.systemInstruction.parts.map((p) => p.text).join("\n"),
    });
  const pending: { id: string; name: string; nativeId?: string }[] = [];
  for (const [turn, content] of req.contents.entries()) {
    if (content.role === "model") {
      if (pending.length) unsupported("unanswered function calls");
      const text: string[] = [];
      const calls: NonNullable<LooseMessage["tool_calls"]> = [];
      for (const [position, part] of content.parts.entries()) {
        if (part.thought) continue; // Private reasoning/signatures are provider-specific.
        if ("text" in part) text.push(part.text);
        else if ("functionCall" in part) {
          const call = part.functionCall;
          const id = `call_${turn}_${position}`;
          pending.push({ id, name: call.name, nativeId: call.id });
          calls.push({
            id,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.args ?? {}),
            },
          });
        } else unsupported("model media or server tool history");
      }
      messages.push({
        role: "assistant",
        content: text.join(""),
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      continue;
    }
    const visible: unknown[] = [];
    for (const part of content.parts) {
      if ("functionResponse" in part) {
        const result = part.functionResponse;
        if (
          result.willContinue ||
          (result.scheduling && result.scheduling !== "SCHEDULING_UNSPECIFIED")
        )
          unsupported("non-blocking function responses");
        const index = pending.findIndex((call) =>
          result.id
            ? call.nativeId === result.id && call.name === result.name
            : call.name === result.name,
        );
        if (index < 0)
          unsupported("a function response without a matching call");
        const [call] = pending.splice(index, 1);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result.response),
        });
      } else if ("text" in part)
        visible.push({ type: "text", text: part.text });
      else if (
        "inlineData" in part &&
        part.inlineData.mimeType?.startsWith("image/")
      ) {
        visible.push({
          type: "image_url",
          image_url: {
            url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
          },
        });
      } else if (
        "inlineData" in part &&
        part.inlineData.mimeType === "application/pdf"
      ) {
        visible.push({
          type: "file",
          file: {
            filename: "document.pdf",
            file_data: `data:application/pdf;base64,${part.inlineData.data}`,
          },
        });
      } else
        unsupported(
          "media other than inline images/PDFs or server tool history",
        );
    }
    if (pending.length) unsupported("incomplete parallel function responses");
    if (visible.length) messages.push({ role: "user", content: visible });
  }
  if (pending.length) unsupported("unanswered function calls");
  const declarations = (
    Array.isArray(req.tools) ? req.tools : req.tools ? [req.tools] : []
  ).flatMap((tool) => {
    if (
      Object.entries(tool).some(
        ([key, value]) => key !== "functionDeclarations" && value !== undefined,
      )
    )
      unsupported("Google-hosted tools");
    return tool.functionDeclarations ?? [];
  });
  const tools = declarations.map((tool) => {
    if (tool.behavior === "NON_BLOCKING") unsupported("non-blocking tools");
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: jsonSchema(
          tool.parametersJsonSchema ??
            tool.parameters ?? { type: "object", properties: {} },
        ),
      },
    };
  });
  const choice = req.toolConfig?.functionCallingConfig;
  const allowed = choice?.allowedFunctionNames;
  // Restrict callable declarations to the allowed set; history remains intact.
  const selectedTools =
    allowed?.length && choice?.mode === "ANY"
      ? tools.filter((tool) => allowed.includes(tool.function.name))
      : tools;
  if (allowed?.length && choice?.mode !== "ANY")
    unsupported("allowedFunctionNames without ANY mode");
  if (allowed?.length && selectedTools.length !== allowed.length)
    unsupported("unknown allowed function names");
  return {
    model: req._model ?? "model-pool",
    messages,
    stream: req._isStreaming === true,
    ...(config.maxOutputTokens !== undefined
      ? { max_tokens: config.maxOutputTokens }
      : {}),
    ...(config.temperature !== undefined
      ? { temperature: config.temperature }
      : {}),
    ...(config.topP !== undefined ? { top_p: config.topP } : {}),
    ...(config.stopSequences ? { stop: config.stopSequences } : {}),
    ...(tools.length ? { tools: selectedTools } : {}),
    ...(choice?.mode
      ? {
          tool_choice:
            choice.mode === "ANY"
              ? "required"
              : choice.mode === "NONE"
                ? "none"
                : "auto",
        }
      : {}),
    // Thinking budgets and signed reasoning are not portable; the destination
    // model uses its own reasoning defaults. Visible conversation is preserved.
  } as OpenAi.Types.ChatCompletionsRequest;
}

function jsonSchema(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const schema = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(schema)) {
    if (key === "propertyOrdering" || key === "nullable") continue;
    if (key === "type") {
      result.type = typeof item === "string" ? item.toLowerCase() : item;
    } else if (
      ["properties", "$defs", "definitions", "patternProperties"].includes(
        key,
      ) &&
      item &&
      typeof item === "object"
    ) {
      result[key] = Object.fromEntries(
        Object.entries(item).map(([name, property]) => [
          name,
          jsonSchema(property),
        ]),
      );
    } else if (
      ["anyOf", "oneOf", "allOf", "prefixItems"].includes(key) &&
      Array.isArray(item)
    ) {
      result[key] = item.map(jsonSchema);
    } else if (
      ["items", "additionalProperties", "not", "contains"].includes(key)
    ) {
      result[key] = jsonSchema(item);
    } else result[key] = item; // Literal enum/default/example values are not schemas.
  }
  if (
    schema.nullable === true &&
    typeof result.type === "string" &&
    result.type !== "null"
  )
    result.type = [result.type, "null"];
  return result;
}

function toolPart(
  id: string,
  name: string,
  args: string,
): Gemini.Types.MessagePart {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args || "{}");
  } catch {
    throw new ApiError(502, "Upstream returned invalid function arguments");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ApiError(
      502,
      "Upstream function arguments must be a JSON object",
    );
  return {
    functionCall: { id, name, args: parsed as Record<string, unknown> },
    thoughtSignature: FOREIGN_THOUGHT_SIGNATURE,
  };
}

function finishReason(reason: string | null | undefined): string {
  return reason === "length"
    ? "MAX_TOKENS"
    : reason === "content_filter"
      ? "SAFETY"
      : "STOP";
}

function usageMetadata(
  usage: NonNullable<OpenAi.Types.ChatCompletionChunk["usage"]>,
): NonNullable<GeminiResponse["usageMetadata"]> {
  const thoughts = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    promptTokenCount: usage.prompt_tokens,
    candidatesTokenCount: Math.max(0, usage.completion_tokens - thoughts),
    thoughtsTokenCount: thoughts,
    cachedContentTokenCount: usage.prompt_tokens_details?.cached_tokens ?? 0,
    totalTokenCount: usage.total_tokens,
  };
}

export function openaiResponseToGemini(
  response: OpenAi.Types.ChatCompletionsResponse,
): GeminiResponse {
  const choice =
    response.choices.find((choice) => choice.index === 0) ??
    response.choices[0];
  if (!choice)
    throw new ApiError(502, "Upstream returned no response candidate");
  const parts: Gemini.Types.MessagePart[] = [];
  if (choice.message.content) parts.push({ text: choice.message.content });
  if (choice.message.refusal) parts.push({ text: choice.message.refusal });
  for (const tool of choice.message.tool_calls ?? []) {
    if (tool.type !== "function")
      throw new ApiError(502, "Upstream returned an unsupported tool call");
    parts.push(toolPart(tool.id, tool.function.name, tool.function.arguments));
  }
  return {
    responseId: response.id,
    modelVersion: response.model,
    candidates: [
      {
        index: 0,
        content: { role: "model", parts },
        finishReason: finishReason(choice.finish_reason),
      },
    ],
    ...(response.usage ? { usageMetadata: usageMetadata(response.usage) } : {}),
  };
}

/** Text stays streaming; calls are emitted only after their JSON is complete. */
export function createOpenaiToGeminiStreamTranslator() {
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let terminal: string | null = null;
  let responseId = "";
  let modelVersion = "";
  let usage: Parameters<typeof usageMetadata>[0] | undefined;
  const chunk = (
    parts: Gemini.Types.MessagePart[],
    reason?: string,
  ): GeminiResponse => ({
    responseId,
    modelVersion,
    candidates: [
      {
        index: 0,
        content: { role: "model", parts },
        ...(reason ? { finishReason: reason } : {}),
      },
    ],
  });
  return {
    translate(event: OpenAi.Types.ChatCompletionChunk): GeminiResponse[] {
      responseId = event.id || responseId;
      modelVersion = event.model || modelVersion;
      if (event.usage) usage = event.usage;
      const choice = event.choices.find((choice) => choice.index === 0);
      if (!choice) return [];
      if (choice.finish_reason) terminal = choice.finish_reason;
      for (const tool of choice.delta.tool_calls ?? []) {
        const call = calls.get(tool.index) ?? { id: "", name: "", args: "" };
        call.id += tool.id ?? "";
        call.name += tool.function?.name ?? "";
        call.args += tool.function?.arguments ?? "";
        calls.set(tool.index, call);
      }
      const text = choice.delta.content ?? choice.delta.refusal;
      return text ? [chunk([{ text }])] : [];
    },
    finish(): GeminiResponse[] {
      if (!terminal)
        throw new UpstreamStreamIncompleteError(
          "The upstream stream ended before it finished",
        );
      const parts = [...calls.values()].map((call) => {
        if (!call.id || !call.name)
          throw new ApiError(
            502,
            "Upstream returned an incomplete function call",
          );
        return toolPart(call.id, call.name, call.args);
      });
      return [
        {
          ...chunk(parts, finishReason(terminal)),
          ...(usage ? { usageMetadata: usageMetadata(usage) } : {}),
        },
      ];
    },
  };
}
