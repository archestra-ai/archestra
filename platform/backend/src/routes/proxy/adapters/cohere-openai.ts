import type {
  Cohere,
  CommonToolCall,
  LLMProvider,
  LLMResponseAdapter,
  LLMStreamAdapter,
  OpenAi,
  StreamAccumulatorState,
  UsageView,
} from "@/types";
import { cohereAdapterFactory } from "./cohere";
import {
  type CohereOpenaiContext,
  cohereResponseToOpenai,
  mapCohereFinishReason,
} from "./cohere-openai-translator";

type CohereRequest = Cohere.Types.ChatRequest;
type CohereResponse = Cohere.Types.ChatResponse;
type CohereMessages = Cohere.Types.ChatRequest["messages"];
type CohereHeaders = Cohere.Types.ChatHeaders;
type CohereStreamChunk = Parameters<
  ReturnType<typeof cohereAdapterFactory.createStreamAdapter>["processChunk"]
>[0];

class CohereOpenaiResponseAdapter
  implements LLMResponseAdapter<CohereResponse>
{
  readonly provider = "cohere" as const;
  private inner: LLMResponseAdapter<CohereResponse>;
  private ctx: CohereOpenaiContext;

  constructor(response: CohereResponse, ctx: CohereOpenaiContext) {
    this.inner = cohereAdapterFactory.createResponseAdapter(response);
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

  getOriginalResponse(): CohereResponse {
    return cohereResponseToOpenai(
      this.inner.getOriginalResponse(),
      this.ctx,
    ) as unknown as CohereResponse;
  }

  getLoggedResponse(): CohereResponse {
    return this.inner.getOriginalResponse();
  }

  getFinishReasons(): string[] {
    return this.inner.getFinishReasons();
  }

  toRefusalResponse(
    _refusalMessage: string,
    contentMessage: string,
  ): CohereResponse {
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
    return response as unknown as CohereResponse;
  }
}

class CohereOpenaiStreamAdapter
  implements LLMStreamAdapter<CohereStreamChunk, CohereResponse>
{
  readonly provider = "cohere" as const;
  private inner: LLMStreamAdapter<CohereStreamChunk, CohereResponse>;
  private ctx: CohereOpenaiContext;

  constructor(ctx: CohereOpenaiContext) {
    this.inner = cohereAdapterFactory.createStreamAdapter();
    this.ctx = ctx;
  }

  get state(): StreamAccumulatorState {
    return this.inner.state;
  }

  processChunk(chunk: CohereStreamChunk) {
    const innerResult = this.inner.processChunk(chunk);
    return { ...innerResult, sseData: this.toOpenaiSse(chunk) };
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
    return [];
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
      finishReason: mapCohereFinishReason(this.inner.state.stopReason),
    })}data: [DONE]\n\n`;
  }

  toProviderResponse(): CohereResponse {
    return this.inner.toProviderResponse();
  }

  private toOpenaiSse(chunk: CohereStreamChunk): string | null {
    if (chunk.type === "message-start") {
      return this.formatChunk({
        delta: { role: "assistant" },
        finishReason: null,
      });
    }
    if (chunk.type === "content-delta") {
      const text = getNestedString(chunk, [
        "delta",
        "message",
        "content",
        "text",
      ]);
      return text
        ? this.formatChunk({ delta: { content: text }, finishReason: null })
        : null;
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

export function makeCohereOpenaiAdapterFactory(
  ctx: CohereOpenaiContext,
): LLMProvider<
  CohereRequest,
  CohereResponse,
  CohereMessages,
  CohereStreamChunk,
  CohereHeaders
> {
  return {
    ...cohereAdapterFactory,
    extractApiKey(headers) {
      const authorization = (headers as Record<string, unknown>).authorization;
      if (typeof authorization === "string") {
        return authorization.replace(/^Bearer\s+/i, "");
      }
      return cohereAdapterFactory.extractApiKey(headers);
    },
    createResponseAdapter(response) {
      return new CohereOpenaiResponseAdapter(response, ctx);
    },
    createStreamAdapter() {
      return new CohereOpenaiStreamAdapter(ctx);
    },
  };
}

function getNestedString(value: unknown, path: string[]): string | null {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" ? current : null;
}
