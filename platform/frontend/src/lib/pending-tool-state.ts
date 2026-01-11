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
  // Track which agent/prompt these actions are for (to invalidate if user switches)
  agentId: string | null;
  promptId: string | null;
}

function getState(): PendingToolState {
  if (typeof window === "undefined") {
    return { actions: [], agentId: null, promptId: null };
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore parse errors
  }
  return { actions: [], agentId: null, promptId: null };
}

function setState(state: PendingToolState): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/**
 * Add a pending tool action.
 * If agentId/promptId changed, clears previous actions first.
 */
export function addPendingAction(
  action: PendingToolAction,
  agentId: string | null,
  promptId: string | null,
): void {
  const state = getState();

  // If context changed, start fresh
  if (state.agentId !== agentId || state.promptId !== promptId) {
    setState({
      actions: [action],
      agentId,
      promptId,
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
 * Get all pending actions for the given context.
 * Returns empty array if context doesn't match.
 */
export function getPendingActions(
  agentId: string | null,
  promptId: string | null,
): PendingToolAction[] {
  const state = getState();

  // Only return actions if context matches
  if (state.agentId !== agentId || state.promptId !== promptId) {
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
 * Check if there are any pending actions for the given context.
 */
export function hasPendingActions(
  agentId: string | null,
  promptId: string | null,
): boolean {
  return getPendingActions(agentId, promptId).length > 0;
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
