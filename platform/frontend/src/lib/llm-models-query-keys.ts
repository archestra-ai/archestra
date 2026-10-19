/**
 * Query key of one model-catalog read (`null` for the caller's whole
 * catalog), kept free of React so the server seed
 * (`lib/chat/new-chat-seed.ts`) writes exactly the key `llm-models.query.ts`
 * reads.
 */
export function llmModelsQueryKey(apiKeyId: string | null) {
  return ["llm-models", apiKeyId] as const;
}
