import { randomUUID } from "node:crypto";
import type { Gemini, OpenAi, StreamAccumulatorState } from "@/types";

type OpenAiRequest = OpenAi.Types.ChatCompletionsRequest;
type OpenAiResponse = OpenAi.Types.ChatCompletionsResponse;
type GeminiRequest = Gemini.Types.GenerateContentRequest;
type GeminiResponse = Gemini.Types.GenerateContentResponse;
type GeminiContent = Gemini.Types.Content;
type GeminiPart = Gemini.Types.Part;

export interface OpenaiContext {
  chatcmplId: string;
  createdUnix: number;
  requestedModel: string;
  includeUsageInStream: boolean;
}

export interface OpenaiToGeminiResult {
  geminiBody: GeminiRequest;
  openaiContext: OpenaiContext;
}

type Loose = any;

export function openaiToGemini(req: OpenAiRequest): OpenaiToGeminiResult {
  const loose = req as Loose;
  let systemInstruction: GeminiContent | undefined = undefined;
  const contents: GeminiContent[] = [];

  for (const m of req.messages ?? []) {
    const role = (m as Loose).role as string;
    if (role === "system" || role === "developer") {
      systemInstruction = {
        role: "user", // Usually ignored for system instruction
        parts: [{ text: stringifyContent((m as Loose).content) }],
      };
      continue;
    }

    if (role === "user") {
      contents.push({
        role: "user",
        parts: userContentToGemini((m as Loose).content),
      });
      continue;
    }

    if (role === "assistant") {
      const parts: GeminiPart[] = [];
      const text = stringifyAssistantText((m as Loose).content);
      if (text) parts.push({ text });
      for (const tc of ((m as Loose).tool_calls ?? []) as Loose[]) {
        if (tc?.type === "function" && tc.function) {
          parts.push({
            functionCall: {
              name: String(tc.function.name ?? ""),
              args: parseJsonObject(tc.function.arguments),
            },
          });
        }
      }
      contents.push({ role: "model", parts });
      continue;
    }

    if (role === "tool") {
      const functionResponse = {
        name: String((m as Loose).name ?? ""),
        response: { result: stringifyContent((m as Loose).content) },
      };
      contents.push({
        role: "user",
        parts: [{ functionResponse }],
      } as any);
    }
  }

  const geminiBody: GeminiRequest = {
    contents,
    generationConfig: {
      temperature: req.temperature ?? undefined,
      topP: req.top_p ?? undefined,
      maxOutputTokens: req.max_tokens ?? undefined,
      stopSequences: typeof req.stop === "string" ? [req.stop] : (Array.isArray(req.stop) ? req.stop : undefined),
    },
  };

  if (systemInstruction) geminiBody.systemInstruction = systemInstruction;
  
  if (Array.isArray(req.tools)) {
    geminiBody.tools = [{
      functionDeclarations: req.tools.map((t: any) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }))
    }] as any;
  }

  const openaiContext: OpenaiContext = {
    chatcmplId: `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    createdUnix: Math.floor(Date.now() / 1000),
    requestedModel: req.model,
    includeUsageInStream: loose.stream_options?.include_usage === true,
  };

  return { geminiBody, openaiContext };
}

export function geminiResponseToOpenai(
  resp: GeminiResponse,
  ctx: OpenaiContext,
): OpenAiResponse {
  const candidate = resp.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  let text = "";
  const toolCalls: any[] = [];

  for (const p of parts) {
    if ("text" in p) {
      text += p.text;
    } else if ("functionCall" in p) {
      toolCalls.push({
        id: `call_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        type: "function",
        function: {
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args ?? {}),
        },
      });
    }
  }

  const usage = {
    prompt_tokens: resp.usageMetadata?.promptTokenCount ?? 0,
    completion_tokens: resp.usageMetadata?.candidatesTokenCount ?? 0,
    total_tokens: resp.usageMetadata?.totalTokenCount ?? 0,
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
        finish_reason: mapStopReason(candidate?.finishReason),
      },
    ],
    usage,
  } as any;
}

function mapStopReason(reason: string | undefined): string {
  switch (reason) {
    case "STOP": return "stop";
    case "MAX_TOKENS": return "length";
    case "SAFETY": return "content_filter";
    case "RECITATION": return "content_filter";
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

function userContentToGemini(content: any): GeminiPart[] {
  if (typeof content === "string") return [{ text: content }];
  if (Array.isArray(content)) {
    return content.map(c => {
      if (c.type === "text") return { text: c.text };
      if (c.type === "image_url") {
        const url = c.image_url.url;
        const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(url);
        if (match) {
          return {
            inlineData: {
              mimeType: match[1],
              data: match[2],
            }
          };
        }
      }
      return c as any;
    });
  }
  return [];
}

function parseJsonObject(str: any): any {
  if (typeof str === "object") return str;
  try { return JSON.parse(str); } catch { return {}; }
}

export function createGeminiToOpenaiSseEncoder(ctx: OpenaiContext) {
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
      const candidate = event.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const out: Uint8Array[] = [];

      if (!rolePrepended) {
        out.push(sse(envelope({ role: "assistant" })));
        rolePrepended = true;
      }

      for (const p of parts) {
        if ("text" in p) {
          out.push(sse(envelope({ content: p.text })));
        } else if ("functionCall" in p) {
          out.push(sse(envelope({
            tool_calls: [{
              index: 0,
              function: {
                name: p.functionCall.name,
                arguments: JSON.stringify(p.functionCall.args ?? {})
              }
            }]
          })));
        }
      }

      if (candidate?.finishReason) {
        out.push(sse(envelope({}, mapStopReason(candidate.finishReason))));
        out.push(encoder.encode("data: [DONE]\n\n"));
      }

      return out.length > 0 ? Buffer.concat(out.map(u => Buffer.from(u))) : null;
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
