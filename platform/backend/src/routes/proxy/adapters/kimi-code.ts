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
import type { CreateClientOptions } from "@/types";
import { createOpenAiCompatibleAdapterFactory } from "./openai-compatible-adapter";
import { PROXY_SDK_MAX_RETRIES } from "./sdk-retry-policy";

// The shape of a Kimi Code sign-in token: opaque, no dots, no spaces.
const KIMI_CODE_SIGN_IN_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

export const kimiCodeAdapterFactory = createOpenAiCompatibleAdapterFactory({
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
      fetch: customFetch,
      defaultHeaders: options.defaultHeaders,
    });
  },
});
