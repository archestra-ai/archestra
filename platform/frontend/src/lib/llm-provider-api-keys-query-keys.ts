/**
 * Query keys of the provider-key reads the chat composer makes, kept free of
 * React so the server seed (`lib/chat/new-chat-seed.ts`) writes exactly the
 * keys the hooks in `llm-provider-api-keys.query.ts` read.
 */
export function llmProviderApiKeysQueryKey(
  search: string | undefined,
  provider: string | undefined,
  filters: ReadonlyArray<unknown> = [],
) {
  return ["llm-provider-api-keys", search, provider, ...filters] as const;
}

export function availableLlmProviderApiKeysQueryKey(
  provider: string | undefined,
  includeKeyId: string | undefined,
) {
  return ["available-llm-provider-api-keys", provider, includeKeyId] as const;
}
