import { useCallback, useEffect, useRef, useState } from "react";

interface ConversationWithTitle {
  id: string;
  title: string | null;
}

interface UseRecentlyGeneratedTitlesOptions {
  animationDuration?: number;
}

interface UseRecentlyGeneratedTitlesReturn {
  /** Set of conversation IDs that have recently generated titles (show typing animation) */
  recentlyGeneratedTitles: Set<string>;
  /** Set of conversation IDs that are waiting for regeneration (show loading state) */
  regeneratingTitles: Set<string>;
  /** Mark a conversation as regenerating (waits for new title before showing animation) */
  triggerRegeneration: (conversationId: string) => void;
}

/**
 * Hook to track conversations that have recently had their titles auto-generated.
 * Detects when a title changes from null to non-null and tracks it for animation purposes.
 * Also provides a function to mark conversations as regenerating (shows loading state until new title arrives).
 *
 * @param conversations - Array of conversations with id and title
 * @param options - Configuration options
 * @returns Object with recentlyGeneratedTitles Set, regeneratingTitles Set, and triggerRegeneration function
 */
export function useRecentlyGeneratedTitles(
  conversations: ConversationWithTitle[],
  options: UseRecentlyGeneratedTitlesOptions = {},
): UseRecentlyGeneratedTitlesReturn {
  const { animationDuration = 3000 } = options;

  const [recentlyGeneratedTitles, setRecentlyGeneratedTitles] = useState<
    Set<string>
  >(new Set());
  const [regeneratingTitles, setRegeneratingTitles] = useState<Set<string>>(
    new Set(),
  );

  // Track previous titles to detect changes
  const previousTitlesRef = useRef<Map<string, string | null>>(new Map());
  // Store individual timeouts per conversation to avoid canceling each other
  const animationTimeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Helper to start animation for a conversation
  const startAnimation = useCallback(
    (conversationId: string) => {
      // Remove from regenerating state
      setRegeneratingTitles((prev) => {
        const next = new Set(prev);
        next.delete(conversationId);
        return next;
      });

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

  // Mark a conversation as regenerating (don't show animation until new title arrives)
  const triggerRegeneration = useCallback((conversationId: string) => {
    setRegeneratingTitles((prev) => new Set(prev).add(conversationId));
  }, []);

  // Detect when a title changes
  useEffect(() => {
    for (const conv of conversations) {
      const previousTitle = previousTitlesRef.current.get(conv.id);
      const isRegenerating = regeneratingTitles.has(conv.id);

      // Title was null before and now has a value -> auto-generated
      const titleGenerated = previousTitle === null && conv.title !== null;
      // Title changed while regenerating -> regenerated
      const titleRegenerated =
        isRegenerating &&
        previousTitle !== undefined &&
        previousTitle !== conv.title &&
        conv.title !== null;

      if (titleGenerated || titleRegenerated) {
        startAnimation(conv.id);
      }

      // Update the previous title ref
      previousTitlesRef.current.set(conv.id, conv.title);
    }
  }, [conversations, regeneratingTitles, startAnimation]);

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

  return { recentlyGeneratedTitles, regeneratingTitles, triggerRegeneration };
}
