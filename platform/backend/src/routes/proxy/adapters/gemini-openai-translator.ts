import { randomUUID } from "node:crypto";
import type { Gemini, OpenAi, UsageView } from "@/types";
import { sanitizeGeminiToolSchema } from "./gemini-schema";
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
  const loose = req as OpenAiRequest & {
    stop?: string | string[] | null;
    top_p?: number | null;
  };
  const systemParts: Array<{ text: string }> = [];
  const contents: GeminiRequest["contents"] = [];

  for (const message of req.messages as LooseMessage[]) {
    if (message.role === "system" || message.role === "developer") {
      systemParts.push({ text: stringifyTextContent(message.content) });
      continue;
    }

    if (message.role === "user") {
      const parts = userContentToGeminiParts(message.content);
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
        parts.push({
          functionCall: {
            id: toolCall.id,
            name: toolCall.function.name,
            args: parseJsonObject(toolCall.function.arguments),
          },
        });
      }
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    if (message.role === "tool") {
      // Gemini carries tool results as a JSON functionResponse payload. Media in
      // a tool result must be nested inside `functionResponse.parts` with
      // displayName/$ref references (Gemini 3 only), which our schema does not
      // model, so tool-result content is forwarded as text.
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              id: message.tool_call_id,
              // OpenAI tool result messages only include tool_call_id, not the
              // original function name. Use a stable synthetic name for Gemini.
              name: "tool_result",
              response: { content: stringifyTextContent(message.content) },
            },
          },
        ],
      });
    }
  }

  const geminiBody: GeminiRequest = {
    contents,
    _model: req.model,
    _isStreaming: req.stream === true,
  };

  if (systemParts.length > 0) {
    geminiBody.systemInstruction = { parts: systemParts };
  }

  if (
    req.temperature !== undefined ||
    req.max_tokens !== undefined ||
    loose.top_p !== undefined ||
    loose.stop !== undefined
  ) {
    geminiBody.generationConfig = {};
    if (req.temperature !== undefined && req.temperature !== null) {
      geminiBody.generationConfig.temperature = req.temperature;
    }
    if (req.max_tokens !== undefined && req.max_tokens !== null) {
      geminiBody.generationConfig.maxOutputTokens = req.max_tokens;
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

/**
 * Same mapping as `geminiUsageToOpenai`, but from the stream accumulator.
 *
 * The accumulator normalizes `inputTokens` to *uncached* input and keeps the
 * cache and thinking counts alongside, so the gross figures OpenAI's wire
 * format expects are reassembled here: `prompt_tokens` adds the cache reads
 * back, and `total_tokens` adds the thinking tokens that Gemini counts in
 * `totalTokenCount` but not in `candidatesTokenCount`.
 *
 * Reading the accumulator rather than the streamed adapter's rebuilt response
 * is deliberate: that rebuild reports `promptTokenCount` net of cache, so it
 * cannot be the source of truth for the gross number.
 */
export function geminiUsageViewToOpenai(
  usage: UsageView | null | undefined,
):
  | { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  | undefined {
  if (!usage) {
    return undefined;
  }
  const promptTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0);
  const completionTokens = usage.outputTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens:
      promptTokens + completionTokens + (usage.reasoningTokens ?? 0),
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
export function geminiUsageToOpenai(response: GeminiResponse): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
  const completionTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens:
      response.usageMetadata?.totalTokenCount ??
      promptTokens + completionTokens,
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
    if ("text" in part && part.text) {
      text += part.text;
      continue;
    }
    if ("functionCall" in part && part.functionCall) {
      toolCalls.push({
        id:
          part.functionCall.id ??
          `gemini-call-${part.functionCall.name}-${Date.now()}`,
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
  for (const part of normalizeOpenAiContentParts(content)) {
    const geminiPart = normalizedPartToGeminiPart(part);
    if (geminiPart) parts.push(geminiPart);
  }
  return parts;
}

// Maps one normalized content part to a Gemini part. Only inline base64 data
// URLs are forwarded (as `inlineData`). Returns null for parts Gemini can't
// represent — notably http(s) image URLs: Gemini's `fileData.fileUri` accepts
// only Files API / gs:// URIs, not arbitrary web URLs, and we don't fetch and
// re-encode external content server-side, so such images are dropped.
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
      return null;
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
      return null;
    }
  }
}
