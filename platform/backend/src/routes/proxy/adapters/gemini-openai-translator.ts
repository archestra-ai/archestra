import { randomUUID } from "node:crypto";
import type { Gemini, OpenAi } from "@/types";
import {
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
      contents.push({
        role: "user",
        parts: [{ text: stringifyTextContent(message.content) }],
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
            parameters: tool.function.parameters,
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

  for (const part of candidate?.content.parts ?? []) {
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

  const promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
  const completionTokens = response.usageMetadata?.candidatesTokenCount ?? 0;

  return {
    id: ctx.chatcmplId,
    object: "chat.completion",
    created: ctx.createdUnix,
    model: ctx.requestedModel,
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason:
          toolCalls.length > 0
            ? "tool_calls"
            : mapGeminiFinishReason(candidate?.finishReason),
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens:
        response.usageMetadata?.totalTokenCount ??
        promptTokens + completionTokens,
    },
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
