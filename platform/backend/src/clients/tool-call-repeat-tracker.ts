// Per-run guard against a model re-issuing the identical tool call forever.
// The agent loop only stops at MAX_AGENT_STEPS (agents/agent-run-stream.ts),
// so a model stuck repeating one call burns hundreds of steps silently. This
// tracker detects consecutive identical (toolName + arguments) calls within a
// single run so the tool layer can nudge the model instead of re-executing.

/**
 * Consecutive identical tool calls that execute normally before the tracker
 * starts nudging. The (N+1)th identical call in a row is the first to nudge.
 * Mirrors MAX_AGENT_STEPS: a named constant, not configuration.
 * @public exported for tests; used internally otherwise.
 */
export const MAX_IDENTICAL_TOOL_CALLS = 3;

interface RepeatRecord {
  /** How many times this exact call has occurred consecutively (>= 1). */
  count: number;
  /** True once the consecutive count exceeds MAX_IDENTICAL_TOOL_CALLS. */
  shouldNudge: boolean;
}

/**
 * Tracks the most recent tool-call fingerprint and how many times in a row it
 * has repeated. One instance per run (held on ChatToolContext), so it carries
 * no cross-run state. Pure and deterministic: no I/O, no clock.
 */
export class ToolCallRepeatTracker {
  private lastFingerprint: string | null = null;
  private consecutiveCount = 0;

  /**
   * Records one tool call. Increments the consecutive count when the call
   * matches the previous one; otherwise resets to 1 for the new call.
   */
  record(
    toolName: string,
    args: Record<string, unknown> | undefined,
  ): RepeatRecord {
    const fingerprint = `${toolName}\0${stableStringify(args)}`;
    if (fingerprint === this.lastFingerprint) {
      this.consecutiveCount += 1;
    } else {
      this.lastFingerprint = fingerprint;
      this.consecutiveCount = 1;
    }
    return {
      count: this.consecutiveCount,
      shouldNudge: this.consecutiveCount > MAX_IDENTICAL_TOOL_CALLS,
    };
  }
}

/**
 * Canonical JSON with object keys sorted recursively, so two argument objects
 * that differ only in key order fingerprint identically. Arrays keep their
 * order (it is meaningful). undefined-valued keys are dropped to match JSON.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
