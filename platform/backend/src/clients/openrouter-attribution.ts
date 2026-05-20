import config from "@/config";

/**
 * OpenRouter attribution headers (`HTTP-Referer`, `X-Title`) for ranking and
 * analytics. Shared by the direct path (`createDirectLLMModel`) and the LLM
 * proxy adapter so both attribute requests identically. Either header is
 * omitted when its config value is unset.
 */
export function openRouterAttributionHeaders(): Record<string, string> {
  return {
    ...(config.llm.openrouter.referer
      ? { "HTTP-Referer": config.llm.openrouter.referer }
      : {}),
    ...(config.llm.openrouter.title
      ? { "X-Title": config.llm.openrouter.title }
      : {}),
  };
}
