import { useCallback, useEffect, useRef, useState } from "react";

interface ConversationWithTitle {
  id: string;
  title: string | null;
}

interface UseRecentlyGeneratedTitlesOptions {
  animationDuration?: number;
}

interface UseRecentlyGeneratedTitlesReturn {
  /** Set of conversation IDs that have recently generated titles */
  recentlyGeneratedTitles: Set<string>;
  /** Manually trigger animation for a conversation (used for regeneration) */
  triggerAnimation: (conversationId: string) => void;
}

/**
 * Hook to track conversations that have recently had their titles auto-generated.
 * Detects when a title changes from null to non-null and tracks it for animation purposes.
 * Also provides a function to manually trigger animation for regenerated titles.
 *
 * @param conversations - Array of conversations with id and title
 * @param options - Configuration options
 * @returns Object with recentlyGeneratedTitles Set and triggerAnimation function
 */
export function useRecentlyGeneratedTitles(
  conversations: ConversationWithTitle[],
  options: UseRecentlyGeneratedTitlesOptions = {},
): UseRecentlyGeneratedTitlesReturn {
  const { animationDuration = 3000 } = options;

  const [recentlyGeneratedTitles, setRecentlyGeneratedTitles] = useState<
    Set<string>
  >(new Set());

  // Track previous titles to detect changes
  const previousTitlesRef = useRef<Map<string, string | null>>(new Map());
  // Store individual timeouts per conversation to avoid canceling each other
  const animationTimeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  // Track conversations that are being regenerated (to detect title changes)
  const regeneratingRef = useRef<Set<string>>(new Set());

  // Helper to start animation for a conversation
  const startAnimation = useCallback(
    (conversationId: string) => {
      // Add to recently generated set
      setRecentlyGeneratedTitles((prev) => new Set(prev).add(conversationId));

      // Clear any existing timeout for this conversation
      const existingTimeout = animationTimeoutsRef.current.get(conversationId);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }

      // Set individual timeout for this conversation
      const timeout = setTimeout(() => {
        setRecentlyGeneratedTitles((prev) => {
          const next = new Set(prev);
          next.delete(conversationId);
          return next;
        });
        animationTimeoutsRef.current.delete(conversationId);
      }, animationDuration);

      animationTimeoutsRef.current.set(conversationId, timeout);
    },
    [animationDuration],
  );

  // Manually trigger animation (for regeneration)
  const triggerAnimation = useCallback(
    (conversationId: string) => {
      // Mark as regenerating so we detect the title change
      regeneratingRef.current.add(conversationId);
      // Start animation immediately (don't wait for API response)
      startAnimation(conversationId);
    },
    [startAnimation],
  );

  // Detect when a title changes
  useEffect(() => {
    for (const conv of conversations) {
      const previousTitle = previousTitlesRef.current.get(conv.id);
      const isRegenerating = regeneratingRef.current.has(conv.id);

      // Title was null before and now has a value -> auto-generated
      // OR title changed while regenerating -> regenerated
      const titleGenerated = previousTitle === null && conv.title !== null;
      const titleRegenerated =
        isRegenerating &&
        previousTitle !== undefined &&
        previousTitle !== conv.title &&
        conv.title !== null;

      if (titleGenerated || titleRegenerated) {
        startAnimation(conv.id);

        // Clear regenerating flag
        if (isRegenerating) {
          regeneratingRef.current.delete(conv.id);
        }
      }

      // Update the previous title ref
      previousTitlesRef.current.set(conv.id, conv.title);
    }
  }, [conversations, startAnimation]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    const timeouts = animationTimeoutsRef.current;
    return () => {
      for (const timeout of timeouts.values()) {
        clearTimeout(timeout);
      }
      timeouts.clear();
    };
  }, []);

  return { recentlyGeneratedTitles, triggerAnimation };
}
