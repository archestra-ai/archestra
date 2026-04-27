import { randomUUID } from "node:crypto";
import type { Anthropic, OpenAi, LLMProvider, LLMResponseAdapter, LLMStreamAdapter, ChunkProcessingResult } from "@/types";
import { anthropicAdapterFactory } from "./anthropic";

type AnthropicRequest = Anthropic.Types.MessagesRequest;
type AnthropicResponse = Anthropic.Types.MessagesResponse;
type AnthropicStreamChunk = any;

export interface OpenaiContext {
  chatcmplId: string;
  createdUnix: number;
  requestedModel: string;
}

export function openaiToAnthropic(req: OpenAi.Types.ChatCompletionsRequest): { 
  anthropicBody: AnthropicRequest, 
  context: OpenaiContext 
} {
  const systemMessages = req.messages.filter(m => m.role === "system" || (m as any).role === "developer");
  const otherMessages = req.messages.filter(m => m.role !== "system" && (m as any).role !== "developer");

  const system = systemMessages.map(m => {
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((p: any) => p.text || "").join("\n");
    }
    return "";
  }).join("\n\n");

  const messages: any[] = [];
  
  for (const m of otherMessages) {
    if (m.role === "user") {
      messages.push({
        role: "user",
        content: typeof m.content === "string" ? m.content : (m.content as any).map((part: any) => {
          if (part.type === "text") return { type: "text", text: part.text };
          if (part.type === "image_url") {
             const match = /^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,(.+)$/i.exec(part.image_url.url);
             if (match) {
               return {
                 type: "image",
                 source: {
                   type: "base64",
                   media_type: match[1],
                   data: match[2]
                 }
               };
             }
          }
          return part;
        })
      });
    } else if (m.role === "assistant") {
      const content: any[] = [];
      if (typeof m.content === "string" && m.content) {
        content.push({ type: "text", text: m.content });
      } else if (Array.isArray(m.content)) {
        content.push(...m.content.map((part: any) => {
          if (part.type === "text") return { type: "text", text: part.text };
          return part;
        }));
      }
      
      if ((m as any).tool_calls) {
        for (const tc of (m as any).tool_calls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments
          });
        }
      }
      messages.push({ role: "assistant", content });
    } else if (m.role === "tool") {
      const toolResult = {
        type: "tool_result",
        tool_use_id: (m as any).tool_call_id,
        content: m.content,
        is_error: false
      };

      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
        (lastMsg.content as any[]).push(toolResult);
      } else {
        messages.push({
          role: "user",
          content: [toolResult]
        });
      }
    }
  }

  const anthropicBody: AnthropicRequest = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens ?? 4096,
    system: system || undefined,
    stream: req.stream ?? undefined,
    temperature: req.temperature ?? undefined,
    top_p: req.top_p ?? undefined,
    stop_sequences: typeof req.stop === "string" ? [req.stop] : req.stop ?? undefined,
    tools: req.tools?.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as any
    }))
  };

  const context: OpenaiContext = {
    chatcmplId: `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    createdUnix: Math.floor(Date.now() / 1000),
    requestedModel: req.model
  };

  return { anthropicBody, context };
}

class AnthropicOpenaiResponseAdapter implements LLMResponseAdapter<AnthropicResponse> {
  readonly provider = "anthropic" as const;
  private inner: LLMResponseAdapter<AnthropicResponse>;
  private ctx: OpenaiContext;

  constructor(response: AnthropicResponse, ctx: OpenaiContext) {
    this.inner = anthropicAdapterFactory.createResponseAdapter(response);
    this.ctx = ctx;
  }

  getId() { return this.inner.getId(); }
  getModel() { return this.ctx.requestedModel; }
  getText() { return this.inner.getText(); }
  getToolCalls() { return this.inner.getToolCalls(); }
  hasToolCalls() { return this.inner.hasToolCalls(); }
  getUsage() { return this.inner.getUsage(); }
  getFinishReasons() { return this.inner.getFinishReasons(); }

  getOriginalResponse(): any {
    const toolCalls = this.getToolCalls();
    const usage = this.getUsage();

    return {
      id: this.ctx.chatcmplId,
      object: "chat.completion",
      created: this.ctx.createdUnix,
      model: this.ctx.requestedModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: this.getText() || null,
            tool_calls: toolCalls.length > 0 ? toolCalls.map(tc => ({
              id: tc.id,
              type: "function",
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments)
              }
            })) : undefined
          },
          finish_reason: this.mapFinishReason(this.getFinishReasons()[0])
        }
      ],
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens
      }
    };
  }

  private mapFinishReason(reason: string | undefined): string {
    if (reason === "tool_use") return "tool_calls";
    if (reason === "max_tokens") return "length";
    if (reason === "end_turn") return "stop";
    return reason || "stop";
  }
  
  toRefusalResponse(_refusalMessage: string, contentMessage: string): any {
    return {
      id: this.ctx.chatcmplId,
      object: "chat.completion",
      created: this.ctx.createdUnix,
      model: this.ctx.requestedModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: contentMessage
          },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    };
  }
}

class AnthropicOpenaiStreamAdapter implements LLMStreamAdapter<AnthropicStreamChunk, AnthropicResponse> {
  readonly provider = "anthropic" as const;
  private inner: LLMStreamAdapter<AnthropicStreamChunk, AnthropicResponse>;
  private ctx: OpenaiContext;

  constructor(ctx: OpenaiContext) {
    this.inner = anthropicAdapterFactory.createStreamAdapter();
    this.ctx = ctx;
  }

  get state() { return this.inner.state; }

  getSSEHeaders() {
    return {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
  }

  processChunk(chunk: AnthropicStreamChunk): ChunkProcessingResult {
    const result = this.inner.processChunk(chunk);
    
    let sseData: string | null = null;
    if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
      const openAiChunk = {
        id: this.ctx.chatcmplId,
        object: "chat.completion.chunk",
        created: this.ctx.createdUnix,
        model: this.ctx.requestedModel,
        choices: [{
          index: 0,
          delta: { content: chunk.delta.text },
          finish_reason: null
        }]
      };
      sseData = `data: ${JSON.stringify(openAiChunk)}\n\n`;
    } else if (chunk.type === "message_stop") {
       const finalChunk = {
        id: this.ctx.chatcmplId,
        object: "chat.completion.chunk",
        created: this.ctx.createdUnix,
        model: this.ctx.requestedModel,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: "stop"
        }]
      };
       sseData = `data: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`;
    }

    return {
      ...result,
      sseData
    };
  }

  formatTextDeltaSSE(text: string) {
     const openAiChunk = {
        id: this.ctx.chatcmplId,
        object: "chat.completion.chunk",
        created: this.ctx.createdUnix,
        model: this.ctx.requestedModel,
        choices: [{
          index: 0,
          delta: { content: text },
          finish_reason: null
        }]
      };
      return `data: ${JSON.stringify(openAiChunk)}\n\n`;
  }

  getRawToolCallEvents() { return []; }
  formatCompleteTextSSE(text: string) { return [this.formatTextDeltaSSE(text)]; }
  formatEndSSE() { return `data: [DONE]\n\n`; }
  
  toProviderResponse(): AnthropicResponse {
    return this.inner.toProviderResponse();
  }
}

export function makeAnthropicOpenaiAdapterFactory(ctx: OpenaiContext): LLMProvider<any, any, any, any, any> {
  return {
    ...anthropicAdapterFactory,
    createResponseAdapter(response) {
      return new AnthropicOpenaiResponseAdapter(response, ctx);
    },
    createStreamAdapter() {
      return new AnthropicOpenaiStreamAdapter(ctx);
    }
  };
}
