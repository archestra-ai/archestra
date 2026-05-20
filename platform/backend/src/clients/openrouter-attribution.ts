import config from "@/config";

/**
 * OpenRouter attribution headers for ranking and analytics. Shared by the
 * direct path (`createDirectLLMModel`) and the LLM proxy adapter so both
 * attribute requests identically. Each header is omitted when its config
 * value is unset.
 *
 * `X-OpenRouter-Title` is the current header name; `X-Title` is the legacy
 * alias OpenRouter still accepts — both are sent so attribution survives
 * either name being phased out.
 */
export function openRouterAttributionHeaders(): Record<string, string> {
  const { referer, title, categories } = config.llm.openrouter;
  return {
    ...(referer ? { "HTTP-Referer": referer } : {}),
    ...(title ? { "X-OpenRouter-Title": title, "X-Title": title } : {}),
    ...(categories ? { "X-OpenRouter-Categories": categories } : {}),
  };
}
