/**
 * Query keys of an agent's delegations, kept free of React so the server
 * seed (`lib/chat/new-chat-seed.ts`) writes exactly the key the hooks in
 * `agent-tools.query.ts` read.
 */
export const agentDelegationsQueryKeys = {
  all: ["agent-delegations"] as const,
  connections: ["agent-delegations", "connections"] as const,
  byAgent: (agentId: string) => ["agent-delegations", agentId] as const,
};
