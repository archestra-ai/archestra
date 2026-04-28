import type {
  Anthropic,
  CommonToolCall,
  LLMProvider,
  LLMResponseAdapter,
  LLMStreamAdapter,
  OpenAi,
  StreamAccumulatorState,
  UsageView,
} from "@/types";
import { anthropicAdapterFactory } from "./anthropic";
import {
  type AnthropicOpenaiContext,
  anthropicResponseToOpenai,
  mapStopReason,
} from "./anthropic-openai-translator";

type AnthropicRequest = Anthropic.Types.MessagesRequest;
type AnthropicResponse = Anthropic.Types.MessagesResponse;
type AnthropicMessages = Anthropic.Types.MessagesRequest["messages"];
type AnthropicHeaders = Anthropic.Types.MessagesHeaders;
type AnthropicStreamChunk = Parameters<
  ReturnType<typeof anthropicAdapterFactory.createStreamAdapter>["processChunk"]
>[0];

class AnthropicOpenaiResponseAdapter
  implements LLMResponseAdapter<AnthropicResponse>
{
  readonly provider = "anthropic" as const;
  private inner: LLMResponseAdapter<AnthropicResponse>;
  private ctx: AnthropicOpenaiContext;

  constructor(response: AnthropicResponse, ctx: AnthropicOpenaiContext) {
    this.inner = anthropicAdapterFactory.createResponseAdapter(response);
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

  getOriginalResponse(): AnthropicResponse {
    // The model router's external wire format is OpenAI, so the handler should
    // send the translated response even though this adapter wraps Anthropic.
    return anthropicResponseToOpenai(
      this.inner.getOriginalResponse(),
      this.ctx,
    ) as unknown as AnthropicResponse;
  }

  getLoggedResponse(): AnthropicResponse {
    return this.inner.getOriginalResponse();
  }

  getFinishReasons(): string[] {
    return this.inner.getFinishReasons();
  }

  toRefusalResponse(
    _refusalMessage: string,
    contentMessage: string,
  ): AnthropicResponse {
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
          message: {
            role: "assistant",
            content: contentMessage,
          },
        },
      ],
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
      },
    };

    return response as unknown as AnthropicResponse;
  }
}

class AnthropicOpenaiStreamAdapter
  implements LLMStreamAdapter<AnthropicStreamChunk, AnthropicResponse>
{
  readonly provider = "anthropic" as const;
  private inner: LLMStreamAdapter<AnthropicStreamChunk, AnthropicResponse>;
  private ctx: AnthropicOpenaiContext;
  private pendingToolCallEvents: string[] = [];

  constructor(ctx: AnthropicOpenaiContext) {
    this.inner = anthropicAdapterFactory.createStreamAdapter();
    this.ctx = ctx;
  }

  get state(): StreamAccumulatorState {
    return this.inner.state;
  }

  processChunk(chunk: AnthropicStreamChunk) {
    const innerResult = this.inner.processChunk(chunk);
    const sseData = this.toOpenaiSse(chunk, innerResult.isToolCallChunk);

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
    return this.formatChunk({
      delta: { content: text },
      finishReason: null,
    });
  }

  getRawToolCallEvents(): string[] {
    return this.pendingToolCallEvents.splice(0);
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
    const finishReason = mapStopReason(
      this.inner.toProviderResponse().stop_reason,
    );
    return `${this.formatChunk({
      delta: {},
      finishReason,
    })}data: [DONE]\n\n`;
  }

  toProviderResponse(): AnthropicResponse {
    return this.inner.toProviderResponse();
  }

  private toOpenaiSse(
    chunk: AnthropicStreamChunk,
    isToolCallChunk: boolean,
  ): string | null {
    if (chunk.type === "message_start") {
      return this.formatChunk({
        delta: { role: "assistant" },
        finishReason: null,
      });
    }

    if (
      chunk.type === "content_block_delta" &&
      chunk.delta.type === "text_delta"
    ) {
      return this.formatChunk({
        delta: { content: chunk.delta.text },
        finishReason: null,
      });
    }

    if (!isToolCallChunk) {
      return null;
    }

    const toolIndex = Math.max(this.state.toolCalls.length - 1, 0);
    if (
      chunk.type === "content_block_start" &&
      chunk.content_block.type === "tool_use"
    ) {
      return this.formatChunk({
        delta: {
          tool_calls: [
            {
              index: toolIndex,
              id: chunk.content_block.id,
              type: "function",
              function: {
                name: chunk.content_block.name,
                arguments: "",
              },
            },
          ],
        },
        finishReason: null,
      });
    }

    if (
      chunk.type === "content_block_delta" &&
      chunk.delta.type === "input_json_delta"
    ) {
      return this.formatChunk({
        delta: {
          tool_calls: [
            {
              index: toolIndex,
              function: {
                arguments: chunk.delta.partial_json,
              },
            },
          ],
        },
        finishReason: null,
      });
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

export function makeAnthropicOpenaiAdapterFactory(
  ctx: AnthropicOpenaiContext,
): LLMProvider<
  AnthropicRequest,
  AnthropicResponse,
  AnthropicMessages,
  AnthropicStreamChunk,
  AnthropicHeaders
> {
  return {
    ...anthropicAdapterFactory,
    extractApiKey(headers) {
      const authorization = (headers as Record<string, unknown>).authorization;
      if (typeof authorization !== "string") {
        return undefined;
      }
      return authorization.replace(/^Bearer\s+/i, "");
    },
    createResponseAdapter(response) {
      return new AnthropicOpenaiResponseAdapter(response, ctx);
    },
    createStreamAdapter() {
      return new AnthropicOpenaiStreamAdapter(ctx);
    },
  };
}
