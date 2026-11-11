/**
 * Kimi Code LLM Proxy Adapter - OpenAI-compatible
 *
 * Kimi Code membership keys (`sk-kimi-…`, from the Kimi Code Console) answer
 * only on the Kimi Code endpoint, with the plan's model ids (k3.1-pro, k3,
 * kimi-for-coding, ...). The API is OpenAI-compatible, so the whole adapter is
 * OpenAI's, configured for Kimi Code via createOpenAiCompatibleAdapterFactory.
 *
 * @see https://www.kimi.com/code/docs/en/
 */
import { stripBearerTransportPrefix } from "@archestra/shared";
import OpenAIProvider from "openai";
import config from "@/config";
import { metrics } from "@/observability";
import type { CreateClientOptions, OpenAi } from "@/types";
import { fetchWithAbortSignal } from "@/utils/client-disconnect-signal";
import { createOpenAiCompatibleAdapterFactory } from "./openai-compatible-adapter";
import { PROXY_SDK_MAX_RETRIES } from "./sdk-retry-policy";

export const kimiCodeAdapterFactory = wrapKimiCodeDeveloperRole(
  createOpenAiCompatibleAdapterFactory({
    provider: "kimi-code",
    interactionType: "kimi-code:chatCompletions",
    getBaseUrl: () => config.llm["kimi-code"].baseUrl,
    // A Kimi Code key (sk-kimi-…) or a Kimi Code sign-in token draws on the
    // membership plan's quota, not per-token billing. Kimi Code 2.3.3 signs in
    // with an opaque token of letters, digits, `-` and `_` (21 characters in
    // practice), never with a JWT. Any other credential, such as a Moonshot
    // `sk-…` key or a placeholder, is metered.
    isSubscriptionCredential: (apiKey) => {
      const credential = stripBearerTransportPrefix(apiKey);
      return (
        credential?.startsWith("sk-kimi-") === true ||
        (!!credential &&
          !credential.startsWith("sk-") &&
          KIMI_CODE_SIGN_IN_TOKEN.test(credential))
      );
    },
    createClient(
      apiKey: string | undefined,
      options: CreateClientOptions,
    ): OpenAIProvider {
      const customFetch = options.agent
        ? metrics.llm.getObservableFetch(
            "kimi-code",
            options.agent,
            options.source,
          )
        : undefined;

      return new OpenAIProvider({
        maxRetries: PROXY_SDK_MAX_RETRIES,
        apiKey,
        baseURL: options.baseUrl ?? config.llm["kimi-code"].baseUrl,
        fetch: fetchWithAbortSignal(customFetch, options.abortSignal),
        defaultHeaders: options.defaultHeaders,
      });
    },
  }),
);

// =============================================================================

// The shape of a Kimi Code sign-in token: opaque, no dots, no spaces.
const KIMI_CODE_SIGN_IN_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

type BaseKimiCodeAdapterFactory = ReturnType<
  typeof createOpenAiCompatibleAdapterFactory
>;

function wrapKimiCodeDeveloperRole(
  baseFactory: BaseKimiCodeAdapterFactory,
): BaseKimiCodeAdapterFactory {
  return {
    ...baseFactory,
    execute(
      client: unknown,
      request: OpenAi.Types.ChatCompletionsRequest,
    ): ReturnType<BaseKimiCodeAdapterFactory["execute"]> {
      return baseFactory.execute(client, withSystemForDeveloperRole(request));
    },
    executeStream(
      client: unknown,
      request: OpenAi.Types.ChatCompletionsRequest,
      onAccepted?: () => void,
    ): ReturnType<BaseKimiCodeAdapterFactory["executeStream"]> {
      return baseFactory.executeStream(
        client,
        withSystemForDeveloperRole(request),
        onAccepted,
      );
    },
  };
}

/**
 * Kimi Code's `/coding/v1/chat/completions` rejects `role: "developer"` with
 * HTTP 400 (`role 'developer' is not allowed`). Rewrite any `developer` message
 * sent by a governed client (e.g., Copilot CLI, OpenCode, Pi) to `system`.
 */
function withSystemForDeveloperRole(
  request: OpenAi.Types.ChatCompletionsRequest,
): OpenAi.Types.ChatCompletionsRequest {
  if (!Array.isArray(request.messages)) return request;
  if (
    !request.messages.some(
      (message) => (message as { role?: string } | null)?.role === "developer",
    )
  ) {
    return request;
  }
  return {
    ...request,
    messages: request.messages.map((message) =>
      (message as { role?: string } | null)?.role === "developer"
        ? ({
            ...(message as Record<string, unknown>),
            role: "system",
          } as typeof message)
        : message,
    ),
  };
}
