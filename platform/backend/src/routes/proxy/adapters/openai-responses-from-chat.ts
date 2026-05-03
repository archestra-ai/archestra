import { randomUUID } from "node:crypto";
import type { SupportedProvider } from "@shared";
import type {
  ChunkProcessingResult,
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

class ResponsesFromChatStreamAdapter<TChunk, TResponse>
  implements LLMStreamAdapter<TChunk, TResponse>
{
  readonly provider: SupportedProvider;
  private inner: LLMStreamAdapter<TChunk, TResponse>;
  private ctx: OpenaiResponsesContext;
  private outputStarted = false;
  private outputCompleted = false;
  private sequenceNumber = 0;
  private readonly itemId = `msg_${randomUUID()}`;

  constructor(
    inner: LLMStreamAdapter<TChunk, TResponse>,
    ctx: OpenaiResponsesContext,
  ) {
    this.inner = inner;
    this.ctx = ctx;
    this.provider = inner.provider;
  }

  get state() {
    return this.inner.state;
  }

  processChunk(chunk: TChunk): ChunkProcessingResult {
    const previousText = this.state.text;
    const result = this.inner.processChunk(chunk);

    if (result.error) {
      return result;
    }

    if (result.isToolCallChunk) {
      return {
        ...result,
        sseData: null,
      };
    }

    const textDelta = this.state.text.slice(previousText.length);
    let sseData = "";
    if (textDelta) {
      sseData += this.ensureOutputStarted();
      sseData += this.toSse({
        type: "response.output_text.delta",
        item_id: this.itemId,
        output_index: 0,
        content_index: 0,
        sequence_number: this.nextSequenceNumber(),
        delta: textDelta,
        logprobs: [],
      });
    }

    if (result.isFinal) {
      sseData += this.completeOutput();
    }

    return {
      ...result,
      sseData: sseData || null,
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
    return [
      this.ensureOutputStarted(),
      this.toSse({
        type: "response.output_text.delta",
        item_id: this.itemId,
        output_index: 0,
        content_index: 0,
        sequence_number: this.nextSequenceNumber(),
        delta: text,
        logprobs: [],
      }),
    ].join("");
  }

  getRawToolCallEvents(): string[] {
    return this.state.toolCalls.flatMap((toolCall, index) => {
      const itemId = `fc_${toolCall.id}`;
      const item = {
        id: itemId,
        call_id: toolCall.id,
        type: "function_call",
        name: toolCall.name,
        arguments: toolCall.arguments,
        status: "completed",
      };

      return [
        this.toSse({
          type: "response.output_item.added",
          output_index: index,
          sequence_number: this.nextSequenceNumber(),
          item,
        }),
        this.toSse({
          type: "response.function_call_arguments.done",
          item_id: itemId,
          output_index: index,
          sequence_number: this.nextSequenceNumber(),
          arguments: toolCall.arguments,
          name: toolCall.name,
        }),
        this.toSse({
          type: "response.output_item.done",
          output_index: index,
          sequence_number: this.nextSequenceNumber(),
          item,
        }),
      ];
    });
  }

  formatCompleteTextSSE(text: string): string[] {
    return [
      this.ensureOutputStarted(),
      this.toSse({
        type: "response.output_text.delta",
        item_id: this.itemId,
        output_index: 0,
        content_index: 0,
        sequence_number: this.nextSequenceNumber(),
        delta: text,
        logprobs: [],
      }),
      this.completeOutput(text),
    ];
  }

  formatEndSSE(): string {
    return "data: [DONE]\n\n";
  }

  toProviderResponse(): TResponse {
    return this.buildResponsesResponse() as unknown as TResponse;
  }

  private ensureOutputStarted(): string {
    if (this.outputStarted) {
      return "";
    }

    this.outputStarted = true;
    return [
      this.toSse({
        type: "response.created",
        sequence_number: this.nextSequenceNumber(),
        response: {
          id: this.ctx.responseId,
          object: "response",
          created_at: this.ctx.createdUnix,
          model: this.ctx.requestedModel,
          status: "in_progress",
          output: [],
        },
      }),
      this.toSse({
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: this.nextSequenceNumber(),
        item: {
          id: this.itemId,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      }),
      this.toSse({
        type: "response.content_part.added",
        item_id: this.itemId,
        output_index: 0,
        content_index: 0,
        sequence_number: this.nextSequenceNumber(),
        part: {
          type: "output_text",
          text: "",
          annotations: [],
        },
      }),
    ].join("");
  }

  private completeOutput(textOverride?: string): string {
    if (this.outputCompleted) {
      return "";
    }

    this.outputCompleted = true;
    const text = textOverride ?? this.state.text;
    return [
      this.outputStarted ? "" : this.ensureOutputStarted(),
      this.toSse({
        type: "response.output_text.done",
        item_id: this.itemId,
        output_index: 0,
        content_index: 0,
        sequence_number: this.nextSequenceNumber(),
        text,
        logprobs: [],
      }),
      this.toSse({
        type: "response.content_part.done",
        item_id: this.itemId,
        output_index: 0,
        content_index: 0,
        sequence_number: this.nextSequenceNumber(),
        part: {
          type: "output_text",
          text,
          annotations: [],
        },
      }),
      this.toSse({
        type: "response.output_item.done",
        output_index: 0,
        sequence_number: this.nextSequenceNumber(),
        item: {
          id: this.itemId,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text,
              annotations: [],
            },
          ],
        },
      }),
      this.toSse({
        type: "response.completed",
        sequence_number: this.nextSequenceNumber(),
        response: this.buildResponsesResponse(),
      }),
    ].join("");
  }

  private buildResponsesResponse() {
    const output = [];

    if (this.state.text) {
      output.push({
        id: this.itemId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: this.state.text,
            annotations: [],
          },
        ],
      });
    }

    output.push(
      ...this.state.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        call_id: toolCall.id,
        type: "function_call",
        name: toolCall.name,
        arguments: toolCall.arguments,
        status: "completed",
      })),
    );

    const inputTokens = this.state.usage?.inputTokens ?? 0;
    const outputTokens = this.state.usage?.outputTokens ?? 0;
    return {
      id: this.ctx.responseId,
      object: "response",
      created_at: this.ctx.createdUnix,
      model: this.ctx.requestedModel,
      status: "completed",
      output,
      usage: this.state.usage
        ? {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          }
        : undefined,
    };
  }

  private nextSequenceNumber(): number {
    this.sequenceNumber += 1;
    return this.sequenceNumber;
  }

  private toSse(event: unknown): string {
    return `data: ${JSON.stringify(event)}\n\n`;
  }
}

export function makeResponsesFromChatAdapterFactory<
  TRequest,
  TResponse,
  TMessages,
  TChunk,
  THeaders,
>(
  provider: LLMProvider<TRequest, TResponse, TMessages, TChunk, THeaders>,
  ctx: OpenaiResponsesContext,
): LLMProvider<TRequest, TResponse, TMessages, TChunk, THeaders> {
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
      return new ResponsesFromChatStreamAdapter(
        provider.createStreamAdapter(...args),
        ctx,
      );
    },
  };
}
