import type { SupportedProvider } from "@shared";
import type {
  CommonToolCall,
  LLMProvider,
  LLMResponseAdapter,
  LLMStreamAdapter,
  OpenAi,
  UsageView,
} from "@/types";
import {
  chatCompletionToResponses,
  type OpenaiResponsesContext,
} from "./openai-responses-translator";

type OpenAiRequest = OpenAi.Types.ChatCompletionsRequest;
type OpenAiResponse = OpenAi.Types.ChatCompletionsResponse;

class ResponsesFromChatAdapter<TResponse>
  implements LLMResponseAdapter<TResponse>
{
  readonly provider: SupportedProvider;
  private inner: LLMResponseAdapter<TResponse>;
  private ctx: OpenaiResponsesContext;

  constructor(
    inner: LLMResponseAdapter<TResponse>,
    ctx: OpenaiResponsesContext,
  ) {
    this.inner = inner;
    this.ctx = ctx;
    this.provider = inner.provider;
  }

  getId(): string {
    return this.ctx.responseId;
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

  getOriginalResponse(): TResponse {
    return chatCompletionToResponses(
      this.inner.getOriginalResponse() as unknown as OpenAiResponse,
      this.ctx,
    ) as unknown as TResponse;
  }

  getLoggedResponse(): TResponse {
    return this.inner.getLoggedResponse
      ? this.inner.getLoggedResponse()
      : this.inner.getOriginalResponse();
  }

  getFinishReasons(): string[] {
    return this.inner.getFinishReasons();
  }

  toRefusalResponse(refusalMessage: string, contentMessage: string): TResponse {
    const refusal = this.inner.toRefusalResponse(
      refusalMessage,
      contentMessage,
    );
    return chatCompletionToResponses(
      refusal as unknown as OpenAiResponse,
      this.ctx,
    ) as unknown as TResponse;
  }
}

export function makeResponsesFromChatAdapterFactory<
  TResponse,
  TMessages,
  TChunk,
  THeaders,
>(
  provider: LLMProvider<OpenAiRequest, TResponse, TMessages, TChunk, THeaders>,
  ctx: OpenaiResponsesContext,
): LLMProvider<OpenAiRequest, TResponse, TMessages, TChunk, THeaders> {
  return {
    ...provider,
    createResponseAdapter(response) {
      return new ResponsesFromChatAdapter(
        provider.createResponseAdapter(response),
        ctx,
      );
    },
    createStreamAdapter(
      ...args: Parameters<typeof provider.createStreamAdapter>
    ) {
      return provider.createStreamAdapter(...args) as LLMStreamAdapter<
        TChunk,
        TResponse
      >;
    },
  };
}
