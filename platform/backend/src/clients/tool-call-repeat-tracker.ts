// Per-run guard against a model re-issuing the identical tool call forever.
// Without a ceiling the agent loop only stops at MAX_AGENT_STEPS
// (agents/agent-run-stream.ts), so a model stuck repeating one call burns
// hundreds of steps silently. This tracker counts consecutive identical
// (toolName + arguments) calls within a single run so the tool layer can nudge
// the model, and — once the repeats cross a ceiling — so the run's stop policy
// can terminate the loop instead of nudging into the void.

import type { StopCondition, ToolSet } from "ai";

/**
 * Consecutive identical tool calls that execute normally before the tracker
 * starts nudging. The (N+1)th identical call in a row is the first to nudge.
 * Mirrors MAX_AGENT_STEPS: a named constant, not configuration.
 * @public exported for tests; used internally otherwise.
 */
export const MAX_IDENTICAL_TOOL_CALLS = 3;

/**
 * Consecutive identical calls at which the breaker stops nudging and the run is
 * terminated (via {@link repeatCeilingStopCondition}). A model still repeating
 * after several nudges will not recover, so stopping here caps wasted compute
 * instead of letting it run to MAX_AGENT_STEPS. Named constant, not config.
 * @public exported for tests and the stop-condition wiring.
 */
export const REPEAT_CALL_TERMINATION_CEILING = 6;

/**
 * Caller-facing result text for a headless run that the ceiling stopped on a
 * tool-call step. The model never got a turn to produce assistant text, so
 * `stream.text` is empty; surfaces a reason in its place. Interactive chat does
 * not need this — it renders the breaker's terminal tool-result part directly.
 */
export const REPEAT_CALL_TERMINATION_NOTICE =
  "The run was stopped because the agent repeatedly issued the same tool call with identical arguments without making progress.";

/**
 * How the breaker should respond to a recorded call:
 * `none` — under threshold, execute normally; `nudge` — skip and nudge;
 * `terminate` — skip, emit a terminal message, and stop the run.
 */
export type RepeatSeverity = "none" | "nudge" | "terminate";

interface RepeatRecord {
  /** How many times this exact call has occurred consecutively (>= 1). */
  count: number;
  /** True once the consecutive count exceeds MAX_IDENTICAL_TOOL_CALLS. */
  shouldNudge: boolean;
  /** Escalation tier for this call, derived from the consecutive count. */
  severity: RepeatSeverity;
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
   * Fingerprint of the most recent call that returned a deterministic
   * (state-independent) error. Compared by value in {@link record}, so an
   * intervening different call or a non-consecutive re-issue never trips the
   * fast nudge — only a consecutive identical repeat of the exact failing call.
   */
  private lastErroredFingerprint: string | null = null;

  /**
   * Records one tool call. Increments the consecutive count when the call
   * matches the previous one; otherwise resets to 1 for the new call.
   */
  record(
    toolName: string,
    args: Record<string, unknown> | undefined,
  ): RepeatRecord {
    const fingerprint = this.fingerprint(toolName, args);
    if (fingerprint === this.lastFingerprint) {
      this.consecutiveCount += 1;
    } else {
      this.lastFingerprint = fingerprint;
      this.consecutiveCount = 1;
    }
    const afterDeterministicError = fingerprint === this.lastErroredFingerprint;
    const severity = severityFor(
      this.consecutiveCount,
      afterDeterministicError,
    );
    return {
      count: this.consecutiveCount,
      shouldNudge: severity !== "none",
      severity,
    };
  }

  /**
   * Marks that `(toolName, args)` just returned an args-deterministic tool error
   * — the looping authoring failures (schema/validation, not-found, policy,
   * stale-version) that an identical re-issue cannot resolve. A later consecutive
   * identical call is then nudged a step sooner than the standard threshold (see
   * {@link severityFor}); the first retry still executes, so a one-off transient
   * error is not blocked, and the nudge is advisory regardless. Call this only
   * for errors that are a function of the arguments, not remote/transient ones.
   */
  noteDeterministicError(
    toolName: string,
    args: Record<string, unknown> | undefined,
  ): void {
    this.lastErroredFingerprint = this.fingerprint(toolName, args);
  }

  private fingerprint(
    toolName: string,
    args: Record<string, unknown> | undefined,
  ): string {
    return `${toolName}\0${stableStringify(args)}`;
  }

  /**
   * Whether the current consecutive streak has reached the termination ceiling.
   * Read by {@link repeatCeilingStopCondition} at each step boundary; the SDK
   * evaluates stop conditions after the step's tool call has been recorded, so
   * the streak this reads already includes the call that hit the ceiling.
   */
  hasReachedTerminationCeiling(): boolean {
    return this.consecutiveCount >= REPEAT_CALL_TERMINATION_CEILING;
  }
}

/**
 * Stop condition bound to one run's tracker: terminates the agent loop once the
 * run's repeated-call streak reaches the ceiling. Added to a caller's `stopWhen`
 * array alongside `stepCountIs(MAX_AGENT_STEPS)`, the same termination channel.
 */
export function repeatCeilingStopCondition(
  tracker: ToolCallRepeatTracker,
): StopCondition<ToolSet> {
  return () => tracker.hasReachedTerminationCeiling();
}

function severityFor(
  count: number,
  afterDeterministicError: boolean,
): RepeatSeverity {
  if (count >= REPEAT_CALL_TERMINATION_CEILING) return "terminate";
  if (count > MAX_IDENTICAL_TOOL_CALLS) return "nudge";
  // An args-deterministic error (schema/validation/not-found/policy/stale) will
  // repeat identically, so nudge it sooner than the standard threshold — but
  // only on the second consecutive re-issue, so the first retry still executes
  // and a one-off transient error is not blocked.
  if (afterDeterministicError && count >= 3) return "nudge";
  return "none";
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
