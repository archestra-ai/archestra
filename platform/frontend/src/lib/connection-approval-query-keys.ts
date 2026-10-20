/**
 * Query keys of the reads the connection approval page makes before it can
 * show its final state, kept free of React so the server seed
 * (`lib/connection-approval-seed.ts`) writes exactly the keys the hooks read.
 */
export const defaultMcpGatewayQueryKey = ["mcp-gateways", "default"] as const;

export const llmProxyQueryKey = ["llm-proxy"] as const;

export const skillNamesQueryKey = ["skills", "names"] as const;

export function clientConnectionQueryKey(id: string) {
  return ["client-connection", id] as const;
}

export function pluginsQueryKey(filters: {
  labels?: string;
  access?: unknown;
  sharedWith?: unknown;
  owner?: unknown;
}) {
  return ["plugins", filters] as const;
}

/** `query` as `useAgentOptionsPage` builds it: built-ins hidden unless the filters say otherwise. */
export function agentOptionsPageQueryKey(query: Record<string, unknown>) {
  return ["agents", "options", "page", query] as const;
}

/** `ids` as `useAgentOptionsByIds` normalises them: unique and sorted. */
export function agentOptionsByIdsQueryKey(ids: string[], filters: unknown) {
  return ["agents", "options", "ids", ids, filters] as const;
}
