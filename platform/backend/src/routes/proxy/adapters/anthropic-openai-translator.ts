import { randomUUID } from "node:crypto";
import type { Anthropic, OpenAi, StreamAccumulatorState } from "@/types";

type OpenAiRequest = OpenAi.Types.ChatCompletionsRequest;
type OpenAiResponse = OpenAi.Types.ChatCompletionsResponse;
type AnthropicRequest = Anthropic.Types.MessagesRequest;
type AnthropicResponse = Anthropic.Types.MessagesResponse;
type AnthropicMessage = Anthropic.Types.Message;
type AnthropicContentBlock = Anthropic.Types.ContentBlock;
type AnthropicStreamEvent = Anthropic.Types.MessageStreamEvent;

export interface OpenaiContext {
  chatcmplId: string;
  createdUnix: number;
  requestedModel: string;
  includeUsageInStream: boolean;
}

export interface OpenaiToAnthropicResult {
  anthropicBody: AnthropicRequest;
  openaiContext: OpenaiContext;
}

type Loose = any;

export function openaiToAnthropic(req: OpenAiRequest): OpenaiToAnthropicResult {
  const loose = req as Loose;
  let system: string | undefined = undefined;
  const messages: AnthropicMessage[] = [];

  for (const m of req.messages ?? []) {
    const role = (m as Loose).role as string;
    if (role === "system" || role === "developer") {
      system = (system ? system + "\n" : "") + stringifyContent((m as Loose).content);
      continue;
    }

    if (role === "user") {
      messages.push({
        role: "user",
        content: userContentToAnthropic((m as Loose).content),
      } as any);
      continue;
    }

    if (role === "assistant") {
      const content: any[] = [];
      const text = stringifyAssistantText((m as Loose).content);
      if (text) content.push({ type: "text", text });
      for (const tc of ((m as Loose).tool_calls ?? []) as Loose[]) {
        if (tc?.type === "function" && tc.function) {
          content.push({
            type: "tool_use",
            id: String(tc.id ?? ""),
            name: String(tc.function.name ?? ""),
            input: parseJsonObject(tc.function.arguments),
          });
        }
      }
      messages.push({ role: "assistant", content } as any);
      continue;
    }

    if (role === "tool") {
      const toolResult = {
        type: "tool_result",
        tool_use_id: String((m as Loose).tool_call_id ?? ""),
        content: stringifyContent((m as Loose).content),
        is_error: false, // Default
      };
      
      const prev = messages[messages.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content)) {
        (prev.content as any).push(toolResult);
      } else {
        messages.push({
          role: "user",
          content: [toolResult],
        } as any);
      }
    }
  }

  const anthropicBody: AnthropicRequest = {
    model: req.model,
    messages: messages as any,
    max_tokens: req.max_tokens ?? 4096,
    stream: Boolean(req.stream),
    temperature: req.temperature ?? undefined,
    top_p: req.top_p ?? undefined,
  };

  if (system) anthropicBody.system = system;
  if (Array.isArray(req.stop)) anthropicBody.stop_sequences = req.stop;
  else if (typeof req.stop === "string") anthropicBody.stop_sequences = [req.stop];

  if (Array.isArray(req.tools)) {
    anthropicBody.tools = req.tools.map((t: any) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    })) as any;
  }

  const openaiContext: OpenaiContext = {
    chatcmplId: `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    createdUnix: Math.floor(Date.now() / 1000),
    requestedModel: req.model,
    includeUsageInStream: loose.stream_options?.include_usage === true,
  };

  return { anthropicBody, openaiContext };
}

export function anthropicResponseToOpenai(
  resp: AnthropicResponse,
  ctx: OpenaiContext,
): OpenAiResponse {
  const blocks = resp.content ?? [];
  let text = "";
  const toolCalls: any[] = [];

  for (const b of blocks as any[]) {
    if (b.type === "text") {
      text += b.text;
    } else if (b.type === "tool_use") {
      toolCalls.push({
        id: b.id,
        type: "function",
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        },
      });
    }
  }

  const usage = {
    prompt_tokens: resp.usage?.input_tokens ?? 0,
    completion_tokens: resp.usage?.output_tokens ?? 0,
    total_tokens: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
  };

  return {
    id: ctx.chatcmplId,
    object: "chat.completion",
    created: ctx.createdUnix,
    model: ctx.requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapStopReason(resp.stop_reason),
      },
    ],
    usage,
  } as any;
}

function mapStopReason(reason: string | null): string {
  switch (reason) {
    case "end_turn": return "stop";
    case "max_tokens": return "length";
    case "tool_use": return "tool_calls";
    case "content_filter": return "content_filter";
    default: return "stop";
  }
}

function stringifyContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(c => (c.type === "text" ? c.text : "")).join("");
  }
  return "";
}

function stringifyAssistantText(content: any): string {
  return stringifyContent(content);
}

function userContentToAnthropic(content: any): any[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    return content.map(c => {
      if (c.type === "text") return { type: "text", text: c.text };
      if (c.type === "image_url") {
        const url = c.image_url.url;
        const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(url);
        if (match) {
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: match[1],
              data: match[2],
            }
          };
        }
      }
      return c;
    });
  }
  return [];
}

function parseJsonObject(str: string): any {
  try { return JSON.parse(str); } catch { return {}; }
}

export function createAnthropicToOpenaiSseEncoder(ctx: OpenaiContext) {
  const encoder = new TextEncoder();
  let rolePrepended = false;

  function envelope(delta: any, finish_reason: string | null = null) {
    return {
      id: ctx.chatcmplId,
      object: "chat.completion.chunk",
      created: ctx.createdUnix,
      model: ctx.requestedModel,
      choices: [{ index: 0, delta, finish_reason }],
    };
  }

  function sse(obj: any) {
    return encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
  }

  return {
    encodeNativeEvent: (event: any): Uint8Array | null => {
      if (event.type === "message_start") {
        rolePrepended = true;
        return sse(envelope({ role: "assistant" }));
      }
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          return sse(envelope({ content: event.delta.text }));
        }
        if (event.delta.type === "input_json_delta") {
          return sse(envelope({
            tool_calls: [{
              index: 0,
              function: { arguments: event.delta.partial_json }
            }]
          }));
        }
      }
      if (event.type === "message_delta") {
        return sse(envelope({}, mapStopReason(event.delta.stop_reason)));
      }
      if (event.type === "message_stop") {
        return encoder.encode("data: [DONE]\n\n");
      }
      return null;
    },
    formatTextDelta: (text: string): Uint8Array => {
      return sse(envelope({ content: text }));
    },
    formatCompleteText: (text: string): Uint8Array[] => {
      return [
        sse(envelope({ role: "assistant" })),
        sse(envelope({ content: text })),
        sse(envelope({}, "stop")),
      ];
    },
    formatEnd: (): Uint8Array => {
      return encoder.encode("data: [DONE]\n\n");
    }
  };
}
