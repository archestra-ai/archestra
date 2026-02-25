import { useMemo, useRef } from "react";

/**
 * Stabilizes conversation order to prevent sidebar "jumping" when React Query
 * re-fetches after mutations that bump `updatedAt` (title generation, model change, etc.).
 *
 * On first render, the backend-provided order is captured as-is.
 * On subsequent re-renders the frozen order is preserved — new conversations are
 * prepended at the top and deleted ones are removed.
 * Order fully resets on page refresh (the ref remounts).
 *
 * Adapted from the approach in PR #2811 (originally copied from Claude's sidebar).
 */
export function useStableConversations<T extends { id: string }>(
  conversations: T[],
): T[] {
  const stableOrderRef = useRef<string[] | null>(null);

  return useMemo(() => {
    if (conversations.length === 0) {
      stableOrderRef.current = null;
      return conversations;
    }

    const currentIds = new Set(conversations.map((c) => c.id));
    const conversationMap = new Map(conversations.map((c) => [c.id, c]));

    if (stableOrderRef.current === null) {
      // First render: capture backend order as-is
      stableOrderRef.current = conversations.map((c) => c.id);
      return conversations;
    }

    const prevIds = new Set(stableOrderRef.current);

    // New conversations not in previous order — prepend at top
    const newIds = conversations
      .filter((c) => !prevIds.has(c.id))
      .map((c) => c.id);

    // Existing conversations in their original order, excluding deleted
    const keptIds = stableOrderRef.current.filter((id) => currentIds.has(id));

    const orderedIds = [...newIds, ...keptIds];
    stableOrderRef.current = orderedIds;

    return orderedIds
      .map((id) => conversationMap.get(id))
      .filter((c): c is NonNullable<typeof c> => c != null);
  }, [conversations]);
}
