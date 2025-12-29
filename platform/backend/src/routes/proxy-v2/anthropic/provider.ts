/**
 * Anthropic Provider Implementation
 *
 * Stateless singleton that implements the Provider interface for Anthropic.
 * SDK client is created inside call()/stream() as needed.
 */

import AnthropicSDK from "@anthropic-ai/sdk";
import type { FastifyReply } from "fastify";
import { get } from "lodash-es";
import config from "@/config";
import { getObservableFetch } from "@/llm-metrics";
import type { Anthropic } from "@/types/llm-providers";
import { MockAnthropicClient } from "../../proxy/mock-anthropic-client";
import * as tracing from "../../proxy/utils/tracing";
import type { Provider, ProxyContext, StreamResult } from "../provider";
import { AnthropicTransformer } from "./transformer";

// Anthropic API types
type AnthropicRequest = Anthropic.Types.MessagesRequest;
type AnthropicResponse = Anthropic.Types.MessagesResponse;
type AnthropicStreamEvent = AnthropicSDK.Messages.MessageStreamEvent;

/**
 * Extract error message from various error formats.
 * Anthropic SDK errors have nested structure: { error: { error: { message: "..." } } }
 */
function getErrorMessage(err: unknown): string {
  const anthropicMessage = get(err, "error.error.message");
  if (typeof anthropicMessage === "string") {
    return anthropicMessage;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return "Internal server error";
}

/**
 * Create Anthropic SDK client
 */
function createClient(context: ProxyContext): AnthropicSDK {
  if (config.benchmark.mockMode) {
    return new MockAnthropicClient() as unknown as AnthropicSDK;
  }

  return new AnthropicSDK({
    apiKey: context.apiKey,
    baseURL: config.llm.anthropic.baseUrl,
    fetch: getObservableFetch(
      "anthropic",
      context.agent,
      context.externalAgentId,
    ),
  });
}

export const anthropicProvider: Provider<
  AnthropicRequest,
  AnthropicResponse,
  AnthropicStreamEvent
> = {
  name: "anthropic",
  interactionType: "anthropic:messages",
  transformer: new AnthropicTransformer(),

  async call(
    request: AnthropicRequest,
    context: ProxyContext,
  ): Promise<AnthropicResponse> {
    const client = createClient(context);

    const response = await tracing.startActiveLlmSpan(
      "anthropic.messages",
      "anthropic",
      request.model,
      false,
      context.agent,
      async (span) => {
        // TODO: ikonstantinov - Type mismatch between our Anthropic schema and SDK:
        // 1. Our schema allows `system` to be a single TextBlockParam object, SDK expects string | TextBlockParam[]
        // 2. Our TextBlockParam has `citations?: any[] | null` but SDK's TextBlockParam doesn't have this field
        // Need to align our schema types with @anthropic-ai/sdk types or add a proper adapter
        // biome-ignore lint/suspicious/noExplicitAny: See TODO above
        const response = await client.messages.create(request as any);
        span.end();
        return response;
      },
    );

    return response as AnthropicResponse;
  },

  async stream(
    request: AnthropicRequest,
    context: ProxyContext,
  ): Promise<StreamResult<AnthropicStreamEvent, AnthropicResponse>> {
    const client = createClient(context);

    const messageStream = await tracing.startActiveLlmSpan(
      "anthropic.messages",
      "anthropic",
      request.model,
      true,
      context.agent,
      async (span) => {
        // biome-ignore lint/suspicious/noExplicitAny: See TODO in call() method
        const stream = client.messages.stream(request as any);
        span.end();
        return stream;
      },
    );

    // Create async iterable wrapper for the stream events
    const events: AsyncIterable<AnthropicStreamEvent> = {
      [Symbol.asyncIterator]() {
        return messageStream[Symbol.asyncIterator]();
      },
    };

    return {
      events,
      async getAccumulatedResponse(): Promise<AnthropicResponse> {
        // The SDK's finalMessage() returns the accumulated response
        const finalMessage = await messageStream.finalMessage();
        return finalMessage as AnthropicResponse;
      },
    };
  },

  setupStreamingHeaders(reply: FastifyReply): void {
    reply.header("Content-Type", "text/event-stream");
    reply.header("Cache-Control", "no-cache");
    reply.header("Connection", "keep-alive");
    reply.header("anthropic-ratelimit-requests-limit", "1000");
    reply.header("anthropic-ratelimit-requests-remaining", "999");
    reply.header(
      "anthropic-ratelimit-requests-reset",
      new Date(Date.now() + 60000).toISOString(),
    );
    reply.header("anthropic-ratelimit-tokens-limit", "100000");
    reply.header("anthropic-ratelimit-tokens-remaining", "99000");
    reply.header(
      "anthropic-ratelimit-tokens-reset",
      new Date(Date.now() + 60000).toISOString(),
    );
    reply.header("request-id", `req-proxy-${Date.now()}`);
  },

  formatErrorResponse(error: unknown): unknown {
    const message = getErrorMessage(error);
    return {
      error: {
        type: "api_error",
        message,
      },
    };
  },

  writeStreamError(reply: FastifyReply, error: unknown): void {
    const message = getErrorMessage(error);
    const errorEvent = {
      type: "error",
      error: { type: "api_error", message },
    };
    reply.raw.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
    reply.raw.end();
  },

  getErrorStatusCode(error: unknown): number {
    if (error instanceof Error && "status" in error) {
      return error.status as number;
    }
    return 500;
  },
};
