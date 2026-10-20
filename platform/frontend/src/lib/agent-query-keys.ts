/**
 * Query keys of the agent reads the chat composer makes, kept free of React
 * so the server seed (`lib/chat/new-chat-seed.ts`) writes exactly the keys
 * the hooks in `agent.query.ts` and `chat/chat.query.ts` read.
 */
export const chatAgentsQueryKey = [
  "agents",
  "chat-roster",
  "bootstrap",
  "v3",
] as const;

export function agentQueryKey(id: string | undefined) {
  return ["agents", id] as const;
}

export function agentDefaultSuggestedPromptsQueryKey(
  agentId: string | null | undefined,
) {
  return ["agents", agentId, "default-suggested-prompts"] as const;
}

/** `ids` as the readiness query normalises them: unique and sorted. */
export function agentCredentialReadinessQueryKey(ids: string[]) {
  return ["agents", "credential-readiness", ids] as const;
}

export function agentCatalogToolsQueryKey(
  agentId: string | undefined,
  catalogId: string,
) {
  return ["agents", agentId, "tools", "catalog", catalogId] as const;
}
