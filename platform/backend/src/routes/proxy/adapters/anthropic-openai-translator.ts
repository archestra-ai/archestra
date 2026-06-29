import { randomUUID } from "node:crypto";
import type { Anthropic, OpenAi } from "@/types";
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
      // Anthropic tool_result content accepts text and image blocks, so forward
      // images returned by a tool instead of flattening them to text. Text-only
      // results stay a plain string to match prior behavior.
      const normalized = normalizeOpenAiContentParts(message.content);
      const hasMedia = normalized.some((part) => part.kind !== "text");
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id ?? "",
            content: hasMedia
              ? userContentToAnthropicBlocks(message.content)
              : stringifyTextContent(message.content),
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
type AnthropicToolResultContent = NonNullable<
  Extract<
    Extract<AnthropicUserContent, readonly unknown[]>[number],
    { type: "tool_result" }
  >["content"]
>;

// Converts an OpenAI user-message `content` into Anthropic content, preserving
// images (base64 data URLs → image blocks) and PDF files (→ document blocks)
// instead of dropping every non-text part. A plain string passes through
// unchanged; nothing convertible falls back to an empty string since Anthropic
// requires non-empty content.
function userContentToAnthropicContent(content: unknown): AnthropicUserContent {
  if (typeof content === "string") return content;
  const blocks = userContentToAnthropicBlocks(content);
  if (blocks.length === 0) return "";
  return blocks as unknown as AnthropicUserContent;
}

// Maps OpenAI content parts to Anthropic content blocks (text, image, base64
// PDF document). Shared by user messages and tool_result blocks. Images use a
// base64 source for data URLs and a url source for http(s) URLs (Anthropic
// fetches them). Audio is dropped since Anthropic models no audio source here.
function userContentToAnthropicBlocks(
  content: unknown,
): AnthropicToolResultContent {
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of normalizeOpenAiContentParts(content)) {
    const block = normalizedPartToAnthropicBlock(part);
    if (block) blocks.push(block);
  }
  return blocks as unknown as AnthropicToolResultContent;
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
