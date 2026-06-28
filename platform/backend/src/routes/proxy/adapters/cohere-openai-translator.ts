import { randomUUID } from "node:crypto";
import type { Cohere, OpenAi } from "@/types";
import {
  normalizeOpenAiContentParts,
  stringifyTextContent,
} from "./openai-translator-utils";

type OpenAiRequest = OpenAi.Types.ChatCompletionsRequest;
type OpenAiResponse = OpenAi.Types.ChatCompletionsResponse;
type CohereRequest = Cohere.Types.ChatRequest;
type CohereResponse = Cohere.Types.ChatResponse;

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

export interface CohereOpenaiContext {
  chatcmplId: string;
  createdUnix: number;
  requestedModel: string;
}

export function openaiToCohere(req: OpenAiRequest): {
  cohereBody: CohereRequest;
  openaiContext: CohereOpenaiContext;
} {
  const loose = req as OpenAiRequest & {
    frequency_penalty?: number | null;
    presence_penalty?: number | null;
    stop?: string | string[] | null;
    top_p?: number | null;
  };

  const messages: CohereRequest["messages"] = [];
  for (const message of req.messages as LooseMessage[]) {
    if (message.role === "system" || message.role === "developer") {
      messages.push({
        role: "system",
        content: stringifyTextContent(message.content),
      });
      continue;
    }
    if (message.role === "user") {
      messages.push({
        role: "user",
        content: userContentToCohereContent(message.content),
      });
      continue;
    }
    if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: stringifyTextContent(message.content),
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      });
      continue;
    }
    if (message.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: message.tool_call_id ?? "",
        content: stringifyTextContent(message.content),
      });
    }
  }

  const cohereBody: CohereRequest = {
    model: req.model,
    messages,
    stream: req.stream === true ? true : undefined,
  };

  if (req.temperature !== undefined && req.temperature !== null) {
    cohereBody.temperature = req.temperature;
  }

  if (req.max_tokens !== undefined && req.max_tokens !== null) {
    cohereBody.max_tokens = req.max_tokens;
  }

  if (loose.top_p !== undefined && loose.top_p !== null) {
    cohereBody.p = loose.top_p;
  }

  if (
    loose.frequency_penalty !== undefined &&
    loose.frequency_penalty !== null
  ) {
    cohereBody.frequency_penalty = loose.frequency_penalty;
  }

  if (loose.presence_penalty !== undefined && loose.presence_penalty !== null) {
    cohereBody.presence_penalty = loose.presence_penalty;
  }

  if (loose.stop !== undefined && loose.stop !== null) {
    cohereBody.stop_sequences = Array.isArray(loose.stop)
      ? loose.stop
      : [loose.stop];
  }

  if (req.tools) {
    cohereBody.tools = req.tools
      .filter((tool) => tool.type === "function")
      .map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters as
            | Cohere.Types.Tool["function"]["parameters"]
            | undefined,
        },
      }));
  }

  if (req.tool_choice === "required") {
    cohereBody.tool_choice = "REQUIRED";
  } else if (req.tool_choice === "none") {
    cohereBody.tool_choice = "NONE";
  }

  return {
    cohereBody,
    openaiContext: {
      chatcmplId: `chatcmpl-${randomUUID()}`,
      createdUnix: Math.floor(Date.now() / 1000),
      requestedModel: req.model,
    },
  };
}

export function cohereResponseToOpenai(
  response: CohereResponse,
  ctx: CohereOpenaiContext,
): OpenAiResponse {
  const text =
    response.message.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("") ?? "";
  const promptTokens =
    response.usage?.tokens?.input_tokens ??
    response.usage?.billed_units?.input_tokens ??
    0;
  const completionTokens =
    response.usage?.tokens?.output_tokens ??
    response.usage?.billed_units?.output_tokens ??
    0;

  return {
    id: ctx.chatcmplId,
    object: "chat.completion",
    created: ctx.createdUnix,
    model: ctx.requestedModel,
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: mapCohereFinishReason(response.finish_reason),
        message: {
          role: "assistant",
          content: text || null,
          ...(response.message.tool_calls
            ? { tool_calls: response.message.tool_calls }
            : {}),
        },
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  } as OpenAiResponse;
}

export function mapCohereFinishReason(
  reason: CohereResponse["finish_reason"] | string | null | undefined,
): "stop" | "length" | "tool_calls" | "content_filter" {
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "TOOL_CALL") return "tool_calls";
  if (reason === "ERROR") return "content_filter";
  return "stop";
}

type CohereUserContent = Cohere.Types.UserMessage["content"];

// Converts an OpenAI user-message `content` into Cohere content, forwarding
// images as `image_url` blocks instead of dropping them. Cohere accepts both
// base64 data URIs and web URLs, so the url passes through unchanged. Audio and
// file parts are dropped since Cohere models no such user content block.
function userContentToCohereContent(content: unknown): CohereUserContent {
  if (typeof content === "string") return content;

  const blocks: Array<Record<string, unknown>> = [];
  for (const part of normalizeOpenAiContentParts(content)) {
    if (part.kind === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.kind === "image") {
      blocks.push({ type: "image_url", image_url: { url: part.url } });
    }
  }

  // Cohere requires non-empty content; fall back to text-only when nothing
  // convertible remained.
  if (blocks.length === 0) return stringifyTextContent(content);
  return blocks as unknown as CohereUserContent;
}
