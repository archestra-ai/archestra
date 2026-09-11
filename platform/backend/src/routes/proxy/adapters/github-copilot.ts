/**
 * GitHub Copilot LLM Proxy Adapter - OpenAI-compatible
 *
 * Copilot reuses OpenAI's chat completions adapter, with missing response
 * choice indices restored for clients that require them.
 * Authentication also differs: the incoming "API key" is a long-lived
 * GitHub OAuth token (`gho_…`), which every outgoing request must swap for a
 * short-lived Copilot bearer (see services/github-copilot-token). The swap
 * happens in a fetch wrapper because `createClient` is synchronous.
 */
import OpenAIProvider from "openai";
import config from "@/config";
import { metrics } from "@/observability";
import { createGithubCopilotFetch } from "@/services/github-copilot-token";
import type { CreateClientOptions, OpenAi } from "@/types";
import { createOpenAiCompatibleAdapterFactory } from "./openai-compatible-adapter";
import { PROXY_SDK_MAX_RETRIES } from "./sdk-retry-policy";

export const githubCopilotAdapterFactory = {
  ...createOpenAiCompatibleAdapterFactory({
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
  }),

  async execute(
    client: unknown,
    request: OpenAi.Types.ChatCompletionsRequest,
  ): Promise<OpenAi.Types.ChatCompletionsResponse> {
    const response = await (client as OpenAIProvider).chat.completions.create({
      ...request,
      stream: false,
    } as OpenAIProvider.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
    // Copilot's Claude completions can omit choice indices. OpenAI clients
    // require them even for a single choice, so restore the positional index.
    return {
      ...response,
      choices: response.choices.map((choice, index) => ({
        ...choice,
        index: choice.index ?? index,
      })),
    } as unknown as OpenAi.Types.ChatCompletionsResponse;
  },
};
