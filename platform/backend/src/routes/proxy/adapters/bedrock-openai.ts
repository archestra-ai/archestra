/**
 * OpenAI ↔ Bedrock Converse compatibility adapter.
 *
 * Accepts a Converse-shaped request (the route translates the OpenAI body before
 * calling handleLLMProxy) and delegates nearly every LLMProvider method to the
 * existing `bedrockAdapterFactory`. Only the adapter outputs that reach the wire
 * — the non-streaming response body and the SSE stream — are translated to
 * OpenAI shapes.
 *
 * Everything between the route and these translations (auth, cost optimization,
 * trusted-data / tool-invocation policies, TOON compression, OTEL, interaction
 * logging) runs on Converse shapes, reusing the battle-tested Bedrock adapter.
 */

import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import type {
  Bedrock,
  ChunkProcessingResult,
  CommonToolCall,
  LLMProvider,
  LLMResponseAdapter,
  LLMStreamAdapter,
  StreamAccumulatorState,
  UsageView,
} from "@/types";
import { bedrockAdapterFactory } from "./bedrock";
import {
  type ConverseToOpenaiSseEncoder,
  converseResponseToOpenai,
  createConverseToOpenaiSseEncoder,
  type OpenaiContext,
} from "./bedrock-openai-translator";

type BedrockRequest = Bedrock.Types.ConverseRequest;
type BedrockResponse = Bedrock.Types.ConverseResponse;
type BedrockMessages = Bedrock.Types.Message[];
type BedrockHeaders = Bedrock.Types.ConverseHeaders;
type BedrockStreamEvent = ConverseStreamOutput;

// biome-ignore lint/suspicious/noExplicitAny: event shape narrowing happens in helpers below
type Loose = any;

class BedrockOpenaiResponseAdapter
  implements LLMResponseAdapter<BedrockResponse>
{
  readonly provider = "bedrock" as const;
  private inner: LLMResponseAdapter<BedrockResponse>;
  private ctx: OpenaiContext;

  constructor(response: BedrockResponse, ctx: OpenaiContext) {
    this.inner = bedrockAdapterFactory.createResponseAdapter(response);
    this.ctx = ctx;
  }

  getId(): string {
    return this.inner.getId();
  }
  getModel(): string {
    // Use the OpenAI-requested model so OTEL spans match what the client asked for
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
  getFinishReasons(): string[] {
    return this.inner.getFinishReasons();
  }

  /**
   * Wire response: OpenAI `chat.completion` shape. Fastify serializes this
   * to the client. Log storage goes through `getLoggedResponse()` below so
   * the interaction row matches the `bedrock:converse` type used by the
   * logs UI parser.
   */
  getOriginalResponse(): BedrockResponse {
    const converse = this.inner.getOriginalResponse();
    return converseResponseToOpenai(
      converse,
      this.ctx,
    ) as unknown as BedrockResponse;
  }

  getLoggedResponse(): BedrockResponse {
    return this.inner.getOriginalResponse();
  }

  /**
   * Policy-blocked response. Construct an OpenAI chat.completion directly;
   * the Bedrock-style refusal shape would not round-trip correctly through
   * OpenAI SDK parsers.
   */
  toRefusalResponse(
    _refusalMessage: string,
    contentMessage: string,
  ): BedrockResponse {
    const usage = this.inner.getUsage();
    return {
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
        prompt_tokens: usage.inputTokens ?? 0,
        completion_tokens: usage.outputTokens ?? 0,
        total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      },
    } as unknown as BedrockResponse;
  }
}

class BedrockOpenaiStreamAdapter
  implements LLMStreamAdapter<BedrockStreamEvent, BedrockResponse>
{
  readonly provider = "bedrock" as const;
  private inner: LLMStreamAdapter<BedrockStreamEvent, BedrockResponse>;
  private encoder: ConverseToOpenaiSseEncoder;
  /**
   * Tool-call events translated at arrival (once) and cached here. The handler
   * retrieves them via `getRawToolCallEvents()` after the per-tool policy
   * decides they can be streamed; for blocked tools the handler simply never
   * calls that method and the bytes are discarded when the stream ends.
   * Translating at arrival (not at flush) avoids repeated encoder state
   * advancement when the handler polls multiple times across chunks.
   */
  private pendingToolCallEventBytes: Uint8Array[] = [];

  constructor(request: BedrockRequest | undefined, ctx: OpenaiContext) {
    this.inner = bedrockAdapterFactory.createStreamAdapter(request);
    this.encoder = createConverseToOpenaiSseEncoder(ctx);
  }

  get state(): StreamAccumulatorState {
    // Proxy read-only to inner's state: policy/telemetry reads here must
    // see the Converse-shape tool calls, not OpenAI-shape.
    return this.inner.state;
  }

  getSSEHeaders(): Record<string, string> {
    return {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
  }

  processChunk(event: BedrockStreamEvent): ChunkProcessingResult {
    // 1. Let the inner Bedrock adapter update its state machine
    //    (text, toolCalls, usage, stopReason, timing). We discard its bytes.
    const innerResult = this.inner.processChunk(event);

    const e = event as Loose;
    const isToolEvent = isToolCallEvent(e);

    if (isToolEvent) {
      // Translate once, cache. The handler may call getRawToolCallEvents()
      // zero or more times — the cache guarantees consistent indexing.
      const bytes = this.encoder.encodeBedrockEvent(event);
      if (bytes) this.pendingToolCallEventBytes.push(bytes);
      return {
        sseData: null,
        isToolCallChunk: true,
        isFinal: innerResult.isFinal,
        error: innerResult.error,
      };
    }

    const sseData = this.encoder.encodeBedrockEvent(event);
    return {
      sseData,
      isToolCallChunk: false,
      isFinal: innerResult.isFinal,
      error: innerResult.error,
    };
  }

  getRawToolCallEvents(): Uint8Array[] {
    return this.pendingToolCallEventBytes;
  }

  formatTextDeltaSSE(text: string): Uint8Array {
    return this.encoder.formatTextDelta(text);
  }

  formatCompleteTextSSE(text: string): Uint8Array[] {
    return this.encoder.formatCompleteText(text);
  }

  formatEndSSE(): Uint8Array {
    return this.encoder.formatEnd();
  }

  /**
   * Stored in the interaction log. Returns the Converse-shape response the
   * inner Bedrock adapter reconstructs from accumulated state — matches the
   * `bedrock:converse` type the logs UI parser expects. The wire bytes the
   * client receives are emitted through `processChunk` / `formatEndSSE`,
   * not through this method.
   */
  toProviderResponse(): BedrockResponse {
    return this.inner.toProviderResponse();
  }
}

function isToolCallEvent(e: Loose): boolean {
  if (e.contentBlockStart?.start?.toolUse) return true;
  if (e.contentBlockDelta?.delta?.toolUse) return true;
  // contentBlockStop doesn't carry a tool marker; emission is handled by the
  // handler via getRawToolCallEvents() based on accumulated index. Returning
  // false here means it flows through encoder → null, which is the desired
  // behavior (no OpenAI equivalent).
  return false;
}

/**
 * Build a per-request LLMProvider that accepts Converse-shaped bodies but
 * emits OpenAI-shaped wire bytes. Intended to be constructed inside a route
 * handler after translating the OpenAI request body via `openaiToConverse`.
 */
export function makeBedrockOpenaiAdapterFactory(
  ctx: OpenaiContext,
): LLMProvider<
  BedrockRequest,
  BedrockResponse,
  BedrockMessages,
  BedrockStreamEvent,
  BedrockHeaders
> {
  return {
    ...bedrockAdapterFactory,
    createResponseAdapter(response) {
      return new BedrockOpenaiResponseAdapter(response, ctx);
    },
    createStreamAdapter(request) {
      return new BedrockOpenaiStreamAdapter(request, ctx);
    },
  };
}
