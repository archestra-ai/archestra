import {
  applyPendingActions,
  type PendingToolAction,
} from "./pending-tool-state";

/**
 * Resolve the enabled-tool IDs for a conversation, applying any pre-conversation
 * pending actions on top of the correct base.
 *
 * The base is the agent's FULL tool set (`allToolIds`) unless the conversation
 * already carries a custom selection — never the empty array. Seeding from `[]`
 * turns a "disable this subset" action into "enable nothing", which persists an
 * empty allowlist that drops every non-built-in tool from the model's context.
 */
export function resolveEnabledToolIds(params: {
  hasCustomSelection: boolean;
  enabledToolIds: string[];
  allToolIds: string[];
  pendingActions?: PendingToolAction[];
}): string[] {
  const {
    hasCustomSelection,
    enabledToolIds,
    allToolIds,
    pendingActions = [],
  } = params;
  const base = hasCustomSelection ? enabledToolIds : allToolIds;
  return applyPendingActions(base, pendingActions);
}
