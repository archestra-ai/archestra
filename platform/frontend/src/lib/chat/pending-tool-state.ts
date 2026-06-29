/**
 * Manages pending tool enable/disable state before a conversation is created.
 * State is stored in localStorage and applied when the first message is sent.
 */

const STORAGE_KEY = "archestra-pending-tool-state";

export type PendingToolAction =
  | { type: "enable"; toolId: string }
  | { type: "disable"; toolId: string }
  | { type: "enableAll"; toolIds: string[] }
  | { type: "disableAll"; toolIds: string[] };

interface PendingToolState {
  actions: PendingToolAction[];
  // Track which agent these actions are for (to invalidate if user switches)
  agentId: string | null;
}

function getState(): PendingToolState {
  if (typeof window === "undefined") {
    return { actions: [], agentId: null };
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore parse errors
  }
  return { actions: [], agentId: null };
}

export const PENDING_TOOL_STATE_CHANGE_EVENT = "pending-tool-state-change";

function setState(state: PendingToolState): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  window.dispatchEvent(new CustomEvent(PENDING_TOOL_STATE_CHANGE_EVENT));
}

/**
 * Add a pending tool action.
 * If agentId changed, clears previous actions first.
 */
export function addPendingAction(
  action: PendingToolAction,
  agentId: string | null,
): void {
  const state = getState();

  // If context changed, start fresh
  if (state.agentId !== agentId) {
    setState({
      actions: [action],
      agentId,
    });
    return;
  }

  // Add to existing actions
  setState({
    ...state,
    actions: [...state.actions, action],
  });
}

/**
 * Get all pending actions for the given agent.
 * Returns empty array if agent doesn't match.
 */
export function getPendingActions(agentId: string | null): PendingToolAction[] {
  const state = getState();

  // Only return actions if agent matches
  if (state.agentId !== agentId) {
    return [];
  }

  return state.actions;
}

/**
 * Clear all pending actions.
 */
export function clearPendingActions(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Check if there are any pending actions for the given agent.
 */
export function hasPendingActions(agentId: string | null): boolean {
  return getPendingActions(agentId).length > 0;
}

/**
 * Apply pending actions to a base set of enabled tool IDs.
 * Returns the new set of enabled tool IDs after applying all actions.
 */
export function applyPendingActions(
  baseEnabledToolIds: string[],
  actions: PendingToolAction[],
): string[] {
  const enabledIds = new Set(baseEnabledToolIds);

  for (const action of actions) {
    switch (action.type) {
      case "enable":
        enabledIds.add(action.toolId);
        break;
      case "disable":
        enabledIds.delete(action.toolId);
        break;
      case "enableAll":
        for (const id of action.toolIds) {
          enabledIds.add(id);
        }
        break;
      case "disableAll":
        for (const id of action.toolIds) {
          enabledIds.delete(id);
        }
        break;
    }
  }

  return Array.from(enabledIds);
}
