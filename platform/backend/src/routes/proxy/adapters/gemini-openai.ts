import type {
  CommonToolCall,
  Gemini,
  LLMProvider,
  LLMResponseAdapter,
  LLMStreamAdapter,
  OpenAi,
  StreamAccumulatorState,
  UsageView,
} from "@/types";
import { geminiAdapterFactory } from "./gemini";
import {
  type GeminiOpenaiContext,
  geminiResponseToOpenai,
  mapGeminiFinishReason,
} from "./gemini-openai-translator";

type GeminiRequest = Gemini.Types.GenerateContentRequest & {
  _model?: string;
  _isStreaming?: boolean;
};
type GeminiResponse = Gemini.Types.GenerateContentResponse;
type GeminiMessages = Gemini.Types.GenerateContentRequest["contents"];
type GeminiHeaders = Gemini.Types.GenerateContentHeaders;
type GeminiStreamChunk = Parameters<
  ReturnType<typeof geminiAdapterFactory.createStreamAdapter>["processChunk"]
>[0];

class GeminiOpenaiResponseAdapter
  implements LLMResponseAdapter<GeminiResponse>
{
  readonly provider = "gemini" as const;
  private inner: LLMResponseAdapter<GeminiResponse>;
  private ctx: GeminiOpenaiContext;

  constructor(response: GeminiResponse, ctx: GeminiOpenaiContext) {
    this.inner = geminiAdapterFactory.createResponseAdapter(response);
    this.ctx = ctx;
  }

  getId(): string {
    return this.inner.getId();
  }

  getModel(): string {
    return this.ctx.requestedModel;
  }

  getText(): string {
    return this.inner.getText();
  }

  getToolCalls(): CommonToolCall[] {
    return this.inner.getToolCalls();
  }

  hasToolCalls(): boolean {
    return this.inner.hasToolCalls();
  }

  getUsage(): UsageView {
    return this.inner.getUsage();
  }

  getOriginalResponse(): GeminiResponse {
    return geminiResponseToOpenai(
      this.inner.getOriginalResponse(),
      this.ctx,
    ) as unknown as GeminiResponse;
  }

  getLoggedResponse(): GeminiResponse {
    return this.inner.getOriginalResponse();
  }

  getFinishReasons(): string[] {
    return this.inner.getFinishReasons();
  }

  toRefusalResponse(
    _refusalMessage: string,
    contentMessage: string,
  ): GeminiResponse {
    const usage = this.inner.getUsage();
    const response: OpenAi.Types.ChatCompletionsResponse = {
      id: this.ctx.chatcmplId,
      object: "chat.completion",
      created: this.ctx.createdUnix,
      model: this.ctx.requestedModel,
      choices: [
        {
          index: 0,
          logprobs: null,
          finish_reason: "stop",
          message: { role: "assistant", content: contentMessage },
        },
      ],
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
      },
    };
    return response as unknown as GeminiResponse;
  }
}

class GeminiOpenaiStreamAdapter
  implements LLMStreamAdapter<GeminiStreamChunk, GeminiResponse>
{
  readonly provider = "gemini" as const;
  private inner: LLMStreamAdapter<GeminiStreamChunk, GeminiResponse>;
  private ctx: GeminiOpenaiContext;
  private pendingToolCallEvents: string[] = [];

  constructor(ctx: GeminiOpenaiContext) {
    this.inner = geminiAdapterFactory.createStreamAdapter();
    this.ctx = ctx;
  }

  get state(): StreamAccumulatorState {
    return this.inner.state;
  }

  processChunk(chunk: GeminiStreamChunk) {
    const innerResult = this.inner.processChunk(chunk);
    const sseData = this.toOpenaiSse(chunk);

    if (innerResult.isToolCallChunk && sseData) {
      this.pendingToolCallEvents.push(sseData);
      return {
        ...innerResult,
        sseData: null,
      };
    }

    return {
      ...innerResult,
      sseData,
    };
  }

  getSSEHeaders(): Record<string, string> {
    return {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
  }

  formatTextDeltaSSE(text: string): string {
    return this.formatChunk({ delta: { content: text }, finishReason: null });
  }

  getRawToolCallEvents(): string[] {
    return this.pendingToolCallEvents;
  }

  formatCompleteTextSSE(text: string): string[] {
    return [
      this.formatChunk({
        delta: { role: "assistant", content: text },
        finishReason: "stop",
      }),
    ];
  }

  formatEndSSE(): string {
    return `${this.formatChunk({
      delta: {},
      finishReason: mapGeminiFinishReason(
        this.inner.toProviderResponse().candidates?.[0]?.finishReason,
      ),
    })}data: [DONE]\n\n`;
  }

  toProviderResponse(): GeminiResponse {
    return this.inner.toProviderResponse();
  }

  private toOpenaiSse(chunk: GeminiStreamChunk): string | null {
    const candidate = chunk.candidates?.[0];
    if (!candidate?.content?.parts) return null;

    for (const part of candidate.content.parts) {
      if ("text" in part && part.text) {
        return this.formatChunk({
          delta: { content: part.text },
          finishReason: null,
        });
      }
      if ("functionCall" in part && part.functionCall) {
        return this.formatChunk({
          delta: {
            tool_calls: [
              {
                index: Math.max(this.state.toolCalls.length - 1, 0),
                id: part.functionCall.id,
                type: "function",
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args ?? {}),
                },
              },
            ],
          },
          finishReason: null,
        });
      }
    }

    return null;
  }

  private formatChunk(params: {
    delta: Record<string, unknown>;
    finishReason: string | null;
  }): string {
    return `data: ${JSON.stringify({
      id: this.ctx.chatcmplId,
      object: "chat.completion.chunk",
      created: this.ctx.createdUnix,
      model: this.ctx.requestedModel,
      choices: [
        {
          index: 0,
          delta: params.delta,
          finish_reason: params.finishReason,
          logprobs: null,
        },
      ],
    })}\n\n`;
  }
}

export function makeGeminiOpenaiAdapterFactory(
  ctx: GeminiOpenaiContext,
): LLMProvider<
  GeminiRequest,
  GeminiResponse,
  GeminiMessages,
  GeminiStreamChunk,
  GeminiHeaders
> {
  return {
    ...geminiAdapterFactory,
    extractApiKey(headers) {
      const authorization = (headers as Record<string, unknown>).authorization;
      if (typeof authorization === "string") {
        return authorization.replace(/^Bearer\s+/i, "");
      }
      return geminiAdapterFactory.extractApiKey(headers);
    },
    createResponseAdapter(response) {
      return new GeminiOpenaiResponseAdapter(response, ctx);
    },
    createStreamAdapter() {
      return new GeminiOpenaiStreamAdapter(ctx);
    },
  };
}
