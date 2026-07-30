/**
 * Perplexity Agent LLM Proxy Adapter — Responses-shaped
 *
 * Perplexity's Agent API is OpenAI-Responses-compatible: `POST /v1/responses`
 * is the documented alias of `POST /v1/agent`, custom functions are declared
 * with the same flat `{ type: "function", name, parameters }` shape, and calls
 * come back as the same `function_call` / `function_call_output` items. Every
 * adapter behaviour is therefore the OpenAI Responses behaviour, so this
 * composes from that factory rather than restating ~900 lines of it.
 *
 * Only the transport identity differs: which provider the interaction is
 * recorded under, which base URL is dialled, and that there is no
 * ChatGPT-subscription credential path. `openAiResponsesAdapterFactory` is a
 * plain object literal holding no state, and the request/response/stream
 * adapters it builds carry no provider-dependent behaviour — their own
 * `provider` fields are interface ballast that nothing reads (the proxy handler
 * reads the factory's). So spreading it is a genuine reuse, not a shallow-copy
 * hazard.
 *
 * @see https://docs.perplexity.ai/api-reference/agent-post
 */
import OpenAIProvider from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import config from "@/config";
import { metrics } from "@/observability";
import type {
  CreateClientOptions,
  LLMProvider,
  PerplexityAgent,
} from "@/types";
import { ApiError } from "@/types";
import { openAiResponsesAdapterFactory } from "./openai-responses";

type PerplexityAgentRequest = PerplexityAgent.Types.ResponsesRequest;
type PerplexityAgentResponse = PerplexityAgent.Types.ResponsesResponse;
type PerplexityAgentHeaders = PerplexityAgent.Types.ResponsesHeaders;
type PerplexityAgentStreamChunk = PerplexityAgent.Types.ResponseChunk;
type PerplexityAgentInput = string | ResponseInput | undefined;

export const perplexityAgentAdapterFactory: LLMProvider<
  PerplexityAgentRequest,
  PerplexityAgentResponse,
  PerplexityAgentInput,
  PerplexityAgentStreamChunk,
  PerplexityAgentHeaders
> = {
  ...openAiResponsesAdapterFactory,

  provider: "perplexity-agent",
  interactionType: "perplexity-agent:responses",

  /**
   * Perplexity issues only metered API keys — there is no subscription
   * credential format here — so this never inherits OpenAI's Codex check. Left
   * inherited, a `chatgpt-oauth:…` string presented to this provider would be
   * billed as flat-rate subscription traffic.
   */
  isSubscriptionCredential(): boolean {
    return false;
  },

  getBaseUrl(): string | undefined {
    return config.llm["perplexity-agent"].baseUrl || undefined;
  },

  createClient(
    apiKey: string | undefined,
    options: CreateClientOptions,
  ): OpenAIProvider {
    if (!apiKey) {
      throw new ApiError(401, "API key required for Perplexity Agent");
    }

    return new OpenAIProvider({
      apiKey,
      baseURL: options.baseUrl || config.llm["perplexity-agent"].baseUrl,
      fetch: options.agent
        ? metrics.llm.getObservableFetch(
            "perplexity-agent",
            options.agent,
            options.source,
          )
        : undefined,
      defaultHeaders: options.defaultHeaders,
    });
  },
};

/**
 * Token extractor for the fetch-based metrics wrapper.
 *
 * A Responses body reports `input_tokens`/`output_tokens`, not the
 * `prompt_tokens`/`completion_tokens` the chat-completions extractor reads, so
 * this cannot borrow `getUsageTokens` from adapters/openai — that one would
 * subtract from `undefined` and publish NaN.
 *
 * Cached tokens are reported inside the input total, so they are subtracted out
 * to leave the uncached input, matching how every other extractor here counts.
 */
export function getUsageTokens(usage: {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}) {
  const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;

  return {
    input: Math.max(0, (usage.input_tokens ?? 0) - cacheRead),
    output: usage.output_tokens ?? 0,
    cacheRead,
    cacheWrite: 0,
    reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0,
  };
}
