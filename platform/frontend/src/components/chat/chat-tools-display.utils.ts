import {
  applyPendingActions,
  type PendingToolAction,
} from "@/lib/pending-tool-state";

/**
 * Compute the default set of enabled tool IDs for a conversation.
 * All tools assigned to the agent are enabled by default.
 */
export function getDefaultEnabledToolIds(
  profileTools: { id: string }[],
): string[] {
  return profileTools.map((t) => t.id);
}

/**
 * Compute the current set of enabled tool IDs based on
 * conversation state, custom selection, and pending actions.
 *
 * Priority:
 * 1. If conversation exists with custom selection → use the custom enabledToolIds
 * 2. If no conversation but pending actions exist → apply them on top of defaults
 * 3. Otherwise → use defaults (all assigned tools enabled)
 */
export function getCurrentEnabledToolIds({
  conversationId,
  hasCustomSelection,
  enabledToolIds,
  defaultEnabledToolIds,
  pendingActions,
}: {
  conversationId: string | undefined;
  hasCustomSelection: boolean;
  enabledToolIds: string[];
  defaultEnabledToolIds: string[];
  pendingActions: PendingToolAction[];
}): string[] {
  if (conversationId && hasCustomSelection) {
    return enabledToolIds;
  }

  const baseIds = defaultEnabledToolIds;

  if (!conversationId && pendingActions.length > 0) {
    return applyPendingActions(baseIds, pendingActions);
  }

  return baseIds;
}
