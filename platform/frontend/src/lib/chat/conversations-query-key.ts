/**
 * Recent conversations the sidebar loads: it shows up to 15 and the rest go
 * through search, so this leaves a margin without paying for 250 rows.
 */
const SIDEBAR_CONVERSATION_LIMIT = 50;

/**
 * The cache key of one conversation list read. Mutations update every list
 * through the `["conversations"]` prefix. Kept free of React so the server
 * seed can key the sidebar's first page the same way.
 */
export function conversationsQueryKey({
  search,
  limit = SIDEBAR_CONVERSATION_LIMIT,
}: {
  search?: string;
  limit?: number;
} = {}) {
  return ["conversations", search, limit] as const;
}
