/**
 * Tracks active subagent executions per conversation using in-memory refcounting.
 *
 * When subagents execute browser tools, they switch the active Playwright tab.
 * The browser preview screenshot stream captures whatever tab is active, causing
 * flickering. This tracker lets the screenshot loop skip capture while subagents
 * are running, holding the last good screenshot instead.
 *
 * NOTE: In-memory only — works when the A2A executor and browser preview WebSocket
 * are on the same pod. In multi-pod deployments the worst case is unchanged
 * flickering (no regression). Can be upgraded to DB/Redis-backed if needed.
 */
class SubagentExecutionTracker {
  private activeCounts = new Map<string, number>();

  increment(isolationKey: string): void {
    this.activeCounts.set(
      isolationKey,
      (this.activeCounts.get(isolationKey) ?? 0) + 1,
    );
  }

  decrement(isolationKey: string): void {
    const count = (this.activeCounts.get(isolationKey) ?? 1) - 1;
    if (count <= 0) {
      this.activeCounts.delete(isolationKey);
    } else {
      this.activeCounts.set(isolationKey, count);
    }
  }

  hasActiveSubagents(isolationKey: string): boolean {
    return (this.activeCounts.get(isolationKey) ?? 0) > 0;
  }
}

export const subagentExecutionTracker = new SubagentExecutionTracker();
