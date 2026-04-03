import { useCallback, useEffect, useState } from "react";

interface UseModelSelectorDisplayParams {
  /** Current conversation ID - collapsed state resets when this changes */
  conversationId?: string;
}

interface UseModelSelectorDisplayResult {
  /** Whether the selector is in collapsed mode (show only provider icon) */
  isCollapsed: boolean;
  /** Expand to show the full model/API key selectors */
  expand: () => void;
}

/**
 * Manages the collapsed/expanded state of the model selector in the chat input.
 *
 * By default, only the provider icon is shown (collapsed). When the user clicks
 * it, the full model and API key selectors are revealed. The state resets back
 * to collapsed when the conversation changes (e.g., navigating to a new chat or
 * switching conversations).
 */
export function useModelSelectorDisplay({
  conversationId,
}: UseModelSelectorDisplayParams = {}): UseModelSelectorDisplayResult {
  const [isExpanded, setIsExpanded] = useState(false);

  // Reset to collapsed when conversation changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: conversationId triggers reset intentionally
  useEffect(() => {
    setIsExpanded(false);
  }, [conversationId]);

  const expand = useCallback(() => setIsExpanded(true), []);

  return {
    isCollapsed: !isExpanded,
    expand,
  };
}
