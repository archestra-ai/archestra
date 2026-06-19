import { randomUUID } from "node:crypto";
import type { Anthropic, OpenAi } from "@/types";
import {
  parseDataUrl,
  parseJsonObject,
  stringifyTextContent,
} from "./openai-translator-utils";

type OpenAiRequest = OpenAi.Types.ChatCompletionsRequest;
type OpenAiResponse = OpenAi.Types.ChatCompletionsResponse;
type AnthropicRequest = Anthropic.Types.MessagesRequest;
type AnthropicResponse = Anthropic.Types.MessagesResponse;

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
  const loose = req as OpenAiRequest & {
    stop?: string | string[] | null;
    top_p?: number | null;
  };
  const system: string[] = [];
  const messages: AnthropicRequest["messages"] = [];

  for (const message of req.messages as LooseMessage[]) {
    if (message.role === "system" || message.role === "developer") {
      system.push(stringifyTextContent(message.content));
      continue;
    }

    if (message.role === "user") {
      messages.push({
        role: "user",
        content: userContentToAnthropicContent(message.content),
      });
      continue;
    }

    if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      const text = stringifyTextContent(message.content);
      if (text) {
        content.push({ type: "text", text });
      }
      for (const toolCall of message.tool_calls ?? []) {
        if (toolCall.type !== "function") continue;
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input: parseJsonObject(toolCall.function.arguments),
        });
      }
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
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id ?? "",
            content: stringifyTextContent(message.content),
          },
        ],
      });
    }
  }

  const anthropicBody: AnthropicRequest = {
    model: req.model,
    max_tokens: req.max_tokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
    messages,
    stream: req.stream === true ? true : undefined,
  };

  if (system.length > 0) {
    anthropicBody.system = system.join("\n\n");
  }

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
      .filter((tool) => tool.type === "function")
      .map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters ?? { type: "object" },
      }));
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

  const promptTokens = response.usage.input_tokens;
  const completionTokens = response.usage.output_tokens;

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
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  } as OpenAiResponse;
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

// Converts an OpenAI user-message `content` into Anthropic content, preserving
// images (base64 data URLs → image blocks) and PDF files (→ document blocks)
// instead of dropping every non-text part. A plain string passes through
// unchanged; http(s) image URLs are dropped since Anthropic's base64 image
// source is the only multimodal source modeled here.
function userContentToAnthropicContent(content: unknown): AnthropicUserContent {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const blocks: Array<Record<string, unknown>> = [];
  for (const part of content as Array<Record<string, LooseContentValue>>) {
    if (!part || typeof part !== "object") continue;

    if (part.type === "text") {
      if (typeof part.text === "string" && part.text) {
        blocks.push({ type: "text", text: part.text });
      }
      continue;
    }

    if (part.type === "image_url") {
      const url = String(getNested(part.image_url, "url") ?? "");
      const inline = parseDataUrl(url);
      if (inline) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: inline.mimeType,
            data: inline.data,
          },
        });
      }
      continue;
    }

    if (part.type === "file") {
      const fileData = String(getNested(part.file, "file_data") ?? "");
      const inline = parseDataUrl(fileData);
      if (inline && inline.mimeType === "application/pdf") {
        blocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: inline.data,
          },
        });
      }
    }
  }

  // Anthropic requires non-empty content; fall back to an empty string when
  // nothing convertible remained.
  if (blocks.length === 0) return "";
  return blocks as AnthropicUserContent;
}

type LooseContentValue = string | Record<string, unknown> | undefined;

function getNested(value: LooseContentValue, key: string): unknown {
  if (value && typeof value === "object") {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
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
