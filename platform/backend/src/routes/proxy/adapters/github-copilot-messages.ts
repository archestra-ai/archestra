import AnthropicProvider from "@anthropic-ai/sdk";
import { get } from "lodash-es";
import config from "@/config";
import { metrics } from "@/observability";
import {
  createGithubCopilotFetch,
  GITHUB_COPILOT_API_VERSION,
} from "@/services/github-copilot-token";
import type { CreateClientOptions } from "@/types";
import { fetchWithAbortSignal } from "@/utils/client-disconnect-signal";
import { anthropicAdapterFactory } from "./anthropic";
import { PROXY_SDK_MAX_RETRIES } from "./sdk-retry-policy";

/** Native Messages transport: retain Anthropic content blocks, not a chat translation. */
export const githubCopilotMessagesAdapterFactory: typeof anthropicAdapterFactory =
  {
    ...anthropicAdapterFactory,
    provider: "github-copilot",
    interactionType: "github-copilot:messages",
    extractApiKey(headers) {
      return (
        headers["x-api-key"] ??
        (headers.authorization?.startsWith("Bearer ")
          ? headers.authorization.slice(7)
          : undefined)
      );
    },
    isSubscriptionCredential() {
      return false;
    },
    getBaseUrl() {
      return config.llm["github-copilot"].baseUrl;
    },
    createClient(apiKey: string | undefined, options: CreateClientOptions) {
      const observableFetch = options.agent
        ? metrics.llm.getObservableFetch(
            "github-copilot",
            options.agent,
            options.source,
            {
              reportTokens: false,
            },
          )
        : undefined;
      const upstreamFetch = fetchWithAbortSignal(
        observableFetch,
        options.abortSignal,
      );
      const copilotFetch = createGithubCopilotFetch({
        githubToken: apiKey,
        providerApiKeyId: options.llmProviderApiKeyId,
        innerFetch: async (input, init) => {
          const headers = new Headers(
            init?.headers ??
              (input instanceof Request ? input.headers : undefined),
          );
          // Never send the SDK placeholder or a caller's Anthropic key to Copilot.
          headers.delete("x-api-key");
          headers.set("openai-intent", "messages-proxy");
          headers.set("x-github-api-version", GITHUB_COPILOT_API_VERSION);
          const response = await (upstreamFetch ?? fetch)(input, {
            ...init,
            headers,
          });
          if (response.ok) options.onResponseHeaders?.(response.headers);
          return response;
        },
      });
      return new AnthropicProvider({
        apiKey: null,
        authToken: "github-copilot",
        maxRetries: PROXY_SDK_MAX_RETRIES,
        baseURL: options.baseUrl ?? config.llm["github-copilot"].baseUrl,
        fetch: copilotFetch,
        defaultHeaders: options.defaultHeaders,
      });
    },
    extractInternalCode() {
      return undefined;
    },
    extractErrorMessage(error: unknown) {
      // Copilot owns authentication and billing; do not classify Anthropic balances.
      const message =
        get(error, "error.error.message") ?? get(error, "error.message");
      return typeof message === "string"
        ? message
        : error instanceof Error
          ? error.message
          : "Internal server error";
    },
  };
