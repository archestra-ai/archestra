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
  geminiUsageViewToOpenai,
  mapGeminiFinishReason,
} from "./gemini-openai-translator";
import { GeminiToolNameCodec } from "./gemini-tool-names";
import {
  formatOpenAiChunkSse,
  type OpenAiStreamUsage,
} from "./openai-sse-chunk";

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
  // The inner (logged-shape) response after a dispatch-mode repair, so
  // getLoggedResponse persists the rewritten turn rather than the original.
  private rewrittenInner: GeminiResponse | null = null;
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
    return this.rewrittenInner ?? this.inner.getOriginalResponse();
  }

  getFinishReasons(): string[] {
    return this.inner.getFinishReasons();
  }

  withRewrittenToolCalls(
    toolCalls: Array<{ id: string; name: string; arguments: string }>,
  ): GeminiResponse {
    // Rewrite in the inner wire shape (which is what gets logged), then
    // translate for the client exactly as getOriginalResponse does. If the
    // inner adapter cannot rewrite, hand back the untouched translation — the
    // handler only reaches here when the planner produced a rewrite, and a
    // silent no-op would strand the client with a call it cannot execute; but
    // every inner adapter this wraps does implement it.
    const inner =
      this.inner.withRewrittenToolCalls?.(toolCalls) ??
      this.inner.getOriginalResponse();
    this.rewrittenInner = inner;
    return geminiResponseToOpenai(inner, this.ctx) as unknown as GeminiResponse;
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
  private toolNameCodec: GeminiToolNameCodec;
  private pendingToolCallEvents: string[] = [];

  constructor(ctx: GeminiOpenaiContext, request?: GeminiRequest) {
    this.inner = geminiAdapterFactory.createStreamAdapter();
    this.ctx = ctx;
    this.toolNameCodec = new GeminiToolNameCodec(request);
  }

  get state(): StreamAccumulatorState {
    return this.inner.state;
  }

  processChunk(chunk: GeminiStreamChunk) {
    const decodedChunk = this.toolNameCodec.decodeResponse(chunk);
    const innerResult = this.inner.processChunk(decodedChunk);
    const sseData = this.toOpenaiSse(decodedChunk);

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

  formatToolCallsSSE(toolCalls: StreamAccumulatorState["toolCalls"]): string[] {
    // The inner (Gemini-shaped) read is a side effect only — it marks the calls
    // as handed over so inner.toProviderResponse() names them — while the wire
    // event below is the OpenAI-shaped one this surface speaks. The buffered
    // OpenAI events are dropped rather than replayed: they name the tool the
    // model called directly, which is the call being repaired.
    this.inner.formatToolCallsSSE?.(toolCalls);
    this.pendingToolCallEvents = [];
    return [
      this.formatChunk({
        delta: {
          tool_calls: toolCalls.map((toolCall, index) => ({
            index,
            id: toolCall.id,
            type: "function" as const,
            function: { name: toolCall.name, arguments: toolCall.arguments },
          })),
        },
        finishReason: null,
      }),
    ];
  }

  formatCompleteTextSSE(text: string): string[] {
    // Mark the inner adapter as refusal-replaced (side effect only; its
    // Gemini-format events are unused here) so it persists the refusal rather
    // than the blocked calls. The finish reason is emitted once, by formatEndSSE.
    this.inner.formatCompleteTextSSE(text);
    return [
      this.formatChunk({
        delta: { role: "assistant", content: text },
        finishReason: null,
      }),
    ];
  }

  formatEndSSE(): string {
    return `${this.formatChunk({
      delta: {},
      finishReason: mapGeminiFinishReason(
        this.inner.toProviderResponse().candidates?.[0]?.finishReason,
      ),
      usage: geminiUsageViewToOpenai(this.state.usage),
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
    /** Only the final chunk passes this; delta chunks must stay usage-free. */
    usage?: OpenAiStreamUsage;
  }): string {
    return formatOpenAiChunkSse({
      id: this.ctx.chatcmplId,
      created: this.ctx.createdUnix,
      model: this.ctx.requestedModel,
      delta: params.delta,
      finishReason: params.finishReason,
      usage: params.usage,
    });
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
    createStreamAdapter(request) {
      return new GeminiOpenaiStreamAdapter(ctx, request);
    },
  };
}
