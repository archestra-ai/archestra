/**
 * GitHub Copilot LLM Proxy Adapter - OpenAI-compatible
 *
 * Copilot serves an OpenAI-compatible chat completions API, so the whole
 * adapter is OpenAI's, configured via createOpenAiCompatibleAdapterFactory.
 * The provider-specific part is auth: the incoming "API key" is a long-lived
 * GitHub OAuth token (`gho_…`), which every outgoing request must swap for a
 * short-lived Copilot bearer (see services/github-copilot-token). The swap
 * happens in a fetch wrapper because `createClient` is synchronous.
 */
import OpenAIProvider from "openai";
import config from "@/config";
import { metrics } from "@/observability";
import { createGithubCopilotFetch } from "@/services/github-copilot-token";
import type { CreateClientOptions } from "@/types";
import { createOpenAiCompatibleAdapterFactory } from "./openai-compatible-adapter";

export const githubCopilotAdapterFactory = createOpenAiCompatibleAdapterFactory(
  {
    provider: "github-copilot",
    interactionType: "github-copilot:chatCompletions",
    getBaseUrl: () => config.llm["github-copilot"].baseUrl,
    createClient(
      apiKey: string | undefined,
      options: CreateClientOptions,
    ): OpenAIProvider {
      const observableFetch = options.agent
        ? metrics.llm.getObservableFetch(
            "github-copilot",
            options.agent,
            options.source,
            options.externalAgentId,
          )
        : undefined;

      return new OpenAIProvider({
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
  },
);
