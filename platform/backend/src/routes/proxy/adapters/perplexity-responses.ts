/**
 * Perplexity Agent LLM Proxy Adapter — Responses-shaped
 *
 * The `perplexity` provider's second surface. Its Agent API is
 * OpenAI-Responses-compatible: `POST /v1/responses` is the documented alias of
 * `POST /v1/agent`, custom functions are declared with the same flat
 * `{ type: "function", name, parameters }` shape, and calls come back as the
 * same `function_call` / `function_call_output` items. Every adapter behaviour
 * is therefore the OpenAI Responses behaviour, so this composes from that
 * factory rather than restating ~900 lines of it.
 *
 * Only the transport identity differs: which interaction type the traffic is
 * recorded under, which base URL is dialled (the provider's one configured
 * host with the Agent API's `/v1` appended), and that there is no
 * ChatGPT-subscription credential path. `openAiResponsesAdapterFactory` is a
 * plain object literal holding no state, and the request/response/stream
 * adapters it builds carry no provider-dependent behaviour — their own
 * `provider` fields are interface ballast that nothing reads (the proxy handler
 * reads the factory's). So spreading it is a genuine reuse, not a shallow-copy
 * hazard.
 *
 * @see https://docs.perplexity.ai/api-reference/agent-post
 */
import { perplexityAgentApiBaseUrl } from "@archestra/shared";
import OpenAIProvider from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import config from "@/config";
import { metrics } from "@/observability";
import type { CreateClientOptions, LLMProvider, Perplexity } from "@/types";
import { ApiError } from "@/types";
import { openAiResponsesAdapterFactory } from "./openai-responses";
import { PROXY_SDK_MAX_RETRIES } from "./sdk-retry-policy";

type PerplexityResponsesRequest = Perplexity.Types.ResponsesRequest;
type PerplexityResponsesResponse = Perplexity.Types.ResponsesResponse;
type PerplexityResponsesHeaders = Perplexity.Types.ResponsesHeaders;
type PerplexityResponseChunk = Perplexity.Types.ResponseChunk;
type PerplexityResponsesInput = string | ResponseInput | undefined;

export const perplexityResponsesAdapterFactory: LLMProvider<
  PerplexityResponsesRequest,
  PerplexityResponsesResponse,
  PerplexityResponsesInput,
  PerplexityResponseChunk,
  PerplexityResponsesHeaders
> = {
  ...openAiResponsesAdapterFactory,

  provider: "perplexity",
  interactionType: "perplexity:responses",

  /**
   * Perplexity issues only metered API keys — there is no subscription
   * credential format here — so this never inherits OpenAI's Codex check. Left
   * inherited, a `chatgpt-oauth:…` string presented to this provider would be
   * billed as flat-rate subscription traffic.
   */
  isSubscriptionCredential(): boolean {
    return false;
  },

  /**
   * Chat-host semantics, deliberately: the handler folds this with per-key
   * overrides and the base-URL header — which all carry the provider's one
   * configured host — and hands the winner back through `options.baseUrl`.
   * Keeping every tier of that fold un-suffixed means createClient below is
   * the single place the Agent API's `/v1` is derived, whichever tier won.
   */
  getBaseUrl(): string | undefined {
    return config.llm.perplexity.baseUrl || undefined;
  },

  createClient(
    apiKey: string | undefined,
    options: CreateClientOptions,
  ): OpenAIProvider {
    if (!apiKey) {
      throw new ApiError(401, "API key required for the Perplexity Agent API");
    }

    return new OpenAIProvider({
      maxRetries: PROXY_SDK_MAX_RETRIES,
      apiKey,
      baseURL: perplexityAgentApiBaseUrl(options.baseUrl),
      fetch: options.agent
        ? metrics.llm.getObservableFetch(
            "perplexity",
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
