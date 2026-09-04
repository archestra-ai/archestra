import config from "@/config";

const TITLE_HEADERS = new Set(["x-openrouter-title", "x-title"]);

/**
 * Adds the configured OpenRouter attribution defaults without replacing
 * caller-provided attribution. Header names are matched case-insensitively,
 * and either supported title alias overrides both configured title aliases.
 */
export function openRouterAttributionHeaders<
  HeaderValue extends string | string[] | undefined = string,
>(
  headers?: Record<string, HeaderValue> | null,
): Record<string, HeaderValue | string> {
  const { referer, title, categories } = config.llm.openrouter;
  const defaults: Record<string, string> = {
    ...(referer ? { "HTTP-Referer": referer } : {}),
    ...(title ? { "X-OpenRouter-Title": title, "X-Title": title } : {}),
    ...(categories ? { "X-OpenRouter-Categories": categories } : {}),
  };
  const incomingNames = new Set(
    Object.keys(headers ?? {}).map((name) => name.toLowerCase()),
  );
  const hasIncomingTitle = [...TITLE_HEADERS].some((name) =>
    incomingNames.has(name),
  );

  for (const name of Object.keys(defaults)) {
    const normalizedName = name.toLowerCase();
    if (
      incomingNames.has(normalizedName) ||
      (hasIncomingTitle && TITLE_HEADERS.has(normalizedName))
    ) {
      delete defaults[name];
    }
  }

  return { ...defaults, ...(headers ?? {}) };
}
