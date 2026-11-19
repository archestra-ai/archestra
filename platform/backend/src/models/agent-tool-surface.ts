/**
 * Change notices for an agent's tool surface: its delegation tool names, its
 * tool exposure mode or its all-tools access. The chat MCP client caches the
 * surface per agent and registers here when it loads, so the agent model tells
 * it to drop a stale entry without importing it. A process that never loaded
 * the client holds no such cache.
 */

/**
 * Calls `listener` with the agent id whenever an agent's tool surface changes.
 * Returns the function that stops it.
 */
export function onAgentToolSurfaceChange(
  listener: (agentId: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tells every listener that this agent's tool surface changed. */
export function agentToolSurfaceChanged(agentId: string): void {
  for (const listener of listeners) listener(agentId);
}

// ===== Internal helpers =====

const listeners = new Set<(agentId: string) => void>();
