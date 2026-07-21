// Per-run guard against a model re-issuing the identical tool call forever.
// Without a ceiling the agent loop only stops at MAX_AGENT_STEPS
// (agents/agent-run-stream.ts), so a model stuck repeating one call burns
// hundreds of steps silently. This tracker counts consecutive identical
// (toolName + arguments) calls within a single run so the tool layer can nudge
// the model, and — once the repeats cross a ceiling — so the run's stop policy
// can terminate the loop instead of nudging into the void.

import {
  type DynamicToolCall,
  NoSuchToolError,
  type StopCondition,
  type ToolSet,
  type TypedToolCall,
} from "ai";

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
  "The run was stopped because the agent repeatedly issued the same tool call without making progress.";

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
   * Streak of steps that called a tool outside the tool list, kept apart from
   * the executed-call streak above. The two are recorded from different points
   * in the loop — a tool's execute wrapper, and a step hook — so sharing one
   * slot would let each reset the other: a step that calls one real tool and
   * one missing tool would build neither streak, and a run that used to
   * terminate on the real tool's repeats would instead run to MAX_AGENT_STEPS.
   */
  private lastUnavailableFingerprint: string | null = null;
  private unavailableConsecutiveCount = 0;

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
   * Records one step that asked for tools which are not in the tool list, keyed
   * on the whole set it asked for. Kept separate from {@link record} — see
   * {@link recordUnavailableToolCallStep} for why these calls are invisible to
   * the tool wrappers in the first place.
   */
  recordUnavailableStep(toolNames: readonly string[]): void {
    // JSON rather than a joined string so the key is injective: ["a,b"] and
    // ["a","b"] are different attempts and must not share a streak.
    const fingerprint = JSON.stringify([...new Set(toolNames)].sort());
    if (fingerprint === this.lastUnavailableFingerprint) {
      this.unavailableConsecutiveCount += 1;
    } else {
      this.lastUnavailableFingerprint = fingerprint;
      this.unavailableConsecutiveCount = 1;
    }
  }

  /**
   * Whether either streak has reached the termination ceiling. Read by
   * {@link repeatCeilingStopCondition} at each step boundary; the SDK evaluates
   * stop conditions after the step's tool calls have been recorded, so the
   * streaks this reads already include the call that hit the ceiling.
   */
  hasReachedTerminationCeiling(): boolean {
    return (
      this.consecutiveCount >= REPEAT_CALL_TERMINATION_CEILING ||
      this.unavailableConsecutiveCount >= REPEAT_CALL_TERMINATION_CEILING
    );
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

/**
 * Fingerprints a finished step in which the model called a tool that is not in
 * its tool list. Call from `onStepFinish` on every `streamText` config that
 * wires {@link repeatCeilingStopCondition}, or that config keeps the blind spot.
 *
 * Such a call never reaches a tool's `execute` wrapper — the SDK turns it into
 * an invalid tool-call plus a synthetic tool-error, feeds that back to the
 * model, and takes another step — so {@link ToolCallRepeatTracker.record} is
 * never reached for it and the ceiling can never fire. A model that keeps
 * asking for a hidden or misremembered tool would otherwise spin to
 * MAX_AGENT_STEPS.
 *
 * A step counts once, however many such calls it made. Six parallel calls at
 * one missing tool are a single decision, not six attempts: counting each would
 * reach the ceiling inside that step and kill the run before the errors it
 * needs in order to recover ever reach it. Counting per step also means the
 * streak measures what it claims — how many times the model saw the failure and
 * repeated it anyway.
 *
 * The SDK awaits `onStepFinish` before it resolves the step, and the step
 * resolves before stop conditions are evaluated, so a streak recorded here is
 * already visible to the ceiling for the same step.
 */
export function recordUnavailableToolCallStep(
  tracker: ToolCallRepeatTracker,
  step: { toolCalls?: readonly ObservedToolCall[] },
): void {
  const names = (step.toolCalls ?? [])
    .filter(isUnavailableToolCall)
    .map((call) => call.toolName);
  if (names.length === 0) return;
  // Keyed on the whole set the step reached for, so naming the same missing
  // tools in a different order is the same attempt — recording only one of them
  // would let a model alternate [a, b] with [b, a] and reset the streak every
  // step. Arguments are left out for the same reason: these calls failed
  // because the tools do not exist, which is a function of the names alone, so
  // fingerprinting the arguments would make every retry look like a fresh
  // attempt and the ceiling would never fire.
  tracker.recordUnavailableStep(names);
}

/**
 * The fields {@link recordUnavailableToolCallStep} reads off a step's tool call.
 * Deliberately structural rather than the SDK's tool-generic `TypedToolCall`,
 * which would push `ToolSet` inference through this module for three fields —
 * the assertions below are what keep that honest.
 */
type ObservedToolCall = {
  toolName?: unknown;
  invalid?: boolean;
  error?: unknown;
};

// Two assertions, because either alone is decorative. Assignability catches a
// field whose type changed, but never a rename: every field above is optional,
// so a tool call carrying none of them still satisfies it. Key presence catches
// the rename. Together, an SDK change that would otherwise leave the guard
// silently matching nothing — quietly restoring the bug this module exists to
// prevent — fails the build instead.
type _SdkToolCallIsObservable =
  TypedToolCall<ToolSet> extends ObservedToolCall ? true : never;
const _assertSdkToolCallIsObservable: _SdkToolCallIsObservable = true;

// Reads the keys off ObservedToolCall rather than repeating them, so a field
// added there is covered without anyone remembering to update a literal. The
// tuples keep the comparison a plain subset check, out of reach of union
// distribution and of however a formatter chooses to break the line.
type _SdkToolCallKeepsObservedKeys = [keyof ObservedToolCall] extends [
  keyof DynamicToolCall,
]
  ? true
  : never;
const _assertSdkToolCallKeepsObservedKeys: _SdkToolCallKeepsObservedKeys = true;

/**
 * Narrows a step's tool call to one the SDK rejected because no such tool
 * exists. `invalid` also covers unparsable arguments for a tool that *does*
 * exist, so the error identity — not the flag alone — is what selects this
 * case: an unparsable call is repaired or surfaced elsewhere, and its retry is
 * fingerprinted normally by the tool wrapper once it parses.
 */
function isUnavailableToolCall(
  call: ObservedToolCall,
): call is ObservedToolCall & { toolName: string } {
  return (
    call.invalid === true &&
    typeof call.toolName === "string" &&
    NoSuchToolError.isInstance(call.error)
  );
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
