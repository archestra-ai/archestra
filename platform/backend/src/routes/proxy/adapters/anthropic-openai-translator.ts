import { randomUUID } from "node:crypto";
import type { Anthropic, OpenAi } from "@/types";

type OpenAiRequest = OpenAi.Types.ChatCompletionsRequest;
type OpenAiResponse = OpenAi.Types.ChatCompletionsResponse;
type AnthropicRequest = Anthropic.Types.MessagesRequest;
type AnthropicResponse = Anthropic.Types.MessagesResponse;

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
      system.push(stringifyContent(message.content));
      continue;
    }

    if (message.role === "user") {
      messages.push({
        role: "user",
        content: stringifyContent(message.content),
      });
      continue;
    }

    if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      const text = stringifyContent(message.content);
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
            content: stringifyContent(message.content),
          },
        ],
      });
    }
  }

  const anthropicBody: AnthropicRequest = {
    model: req.model,
    max_tokens: req.max_tokens ?? 4096,
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

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return {};
  }
  return {};
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
