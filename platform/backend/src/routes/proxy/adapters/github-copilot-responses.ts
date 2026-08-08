/**
 * GitHub Copilot LLM Proxy Adapter — Responses-shaped
 *
 * The `github-copilot` provider's second surface. Copilot serves an
 * OpenAI-compatible `POST /responses` alongside `/chat/completions`, and its
 * Codex and GPT-5.x models are reachable *only* there — they declare
 * `supported_endpoints: ["/responses"]` and reject chat completions outright.
 *
 * Every adapter behaviour is the OpenAI Responses behaviour, so this composes
 * from that factory rather than restating it, exactly as
 * `perplexity-responses` does. `openAiResponsesAdapterFactory` is a plain
 * object literal holding no state, and the adapters it builds carry no
 * provider-dependent behaviour, so spreading it is genuine reuse rather than a
 * shallow-copy hazard.
 *
 * What differs is auth, and it is the same difference as the chat surface: the
 * incoming "API key" is a long-lived GitHub OAuth token (`gho_…`) that Copilot
 * does not accept directly, so every outgoing request swaps it for a
 * short-lived Copilot bearer. That swap lives in a fetch wrapper because
 * `createClient` is synchronous. Inheriting OpenAI's `createClient` here would
 * send the raw GitHub token upstream and 401 on every call.
 */
import OpenAIProvider from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import config from "@/config";
import { metrics } from "@/observability";
import { createGithubCopilotFetch } from "@/services/github-copilot-token";
import type { CreateClientOptions, GithubCopilot, LLMProvider } from "@/types";
import { openAiResponsesAdapterFactory } from "./openai-responses";
import { PROXY_SDK_MAX_RETRIES } from "./sdk-retry-policy";

type GithubCopilotResponsesRequest = GithubCopilot.Types.ResponsesRequest;
type GithubCopilotResponsesResponse = GithubCopilot.Types.ResponsesResponse;
type GithubCopilotResponsesHeaders = GithubCopilot.Types.ResponsesHeaders;
type GithubCopilotResponseChunk = GithubCopilot.Types.ResponseChunk;
type GithubCopilotResponsesInput = string | ResponseInput | undefined;

export const githubCopilotResponsesAdapterFactory: LLMProvider<
  GithubCopilotResponsesRequest,
  GithubCopilotResponsesResponse,
  GithubCopilotResponsesInput,
  GithubCopilotResponseChunk,
  GithubCopilotResponsesHeaders
> = {
  ...openAiResponsesAdapterFactory,

  provider: "github-copilot",
  interactionType: "github-copilot:responses",

  /**
   * Copilot credentials are GitHub OAuth tokens, never the `chatgpt-oauth:…`
   * marker strings OpenAI's check looks for — so the inherited implementation
   * would answer `false` anyway. Stated explicitly because leaving it inherited
   * makes that a coincidence of OpenAI's format check rather than a decision,
   * and because it must stay in lockstep with the chat surface: a provider
   * whose two surfaces disagree about billing mode would bill the same
   * subscription differently depending on which endpoint the client happened to
   * call.
   */
  isSubscriptionCredential(): boolean {
    return false;
  },

  getBaseUrl(): string | undefined {
    return config.llm["github-copilot"].baseUrl || undefined;
  },

  createClient(
    apiKey: string | undefined,
    options: CreateClientOptions,
  ): OpenAIProvider {
    const observableFetch = options.agent
      ? metrics.llm.getObservableFetch(
          "github-copilot",
          options.agent,
          options.source,
        )
      : undefined;

    return new OpenAIProvider({
      maxRetries: PROXY_SDK_MAX_RETRIES,
      // Placeholder satisfies the SDK; the wrapper sets the real bearer.
      apiKey: apiKey ?? "github-copilot",
      baseURL: options.baseUrl ?? config.llm["github-copilot"].baseUrl,
      fetch: createGithubCopilotFetch({
        githubToken: apiKey,
        innerFetch: observableFetch,
      }),
      defaultHeaders: options.defaultHeaders,
    });
  },
};
