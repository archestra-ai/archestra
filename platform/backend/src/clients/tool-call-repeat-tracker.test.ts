import { describe, expect, it } from "vitest";
import {
  MAX_IDENTICAL_TOOL_CALLS,
  REPEAT_CALL_TERMINATION_CEILING,
  repeatCeilingStopCondition,
  ToolCallRepeatTracker,
} from "./tool-call-repeat-tracker";

describe("ToolCallRepeatTracker", () => {
  it("counts consecutive identical calls and nudges only past the threshold", () => {
    const tracker = new ToolCallRepeatTracker();
    const args = { path: "/tmp/x" };

    for (let i = 1; i <= MAX_IDENTICAL_TOOL_CALLS; i++) {
      const record = tracker.record("read_file", args);
      expect(record).toEqual({
        count: i,
        shouldNudge: false,
        severity: "none",
      });
    }

    const overThreshold = tracker.record("read_file", args);
    expect(overThreshold).toEqual({
      count: MAX_IDENTICAL_TOOL_CALLS + 1,
      shouldNudge: true,
      severity: "nudge",
    });
  });

  it("escalates to terminate at the ceiling", () => {
    const tracker = new ToolCallRepeatTracker();
    const args = { q: "stuck" };

    // Below the ceiling the breaker only nudges.
    for (let i = 1; i < REPEAT_CALL_TERMINATION_CEILING; i++) {
      const record = tracker.record("search", args);
      expect(record.severity).toBe(
        i > MAX_IDENTICAL_TOOL_CALLS ? "nudge" : "none",
      );
      expect(tracker.hasReachedTerminationCeiling()).toBe(false);
    }

    const atCeiling = tracker.record("search", args);
    expect(atCeiling).toEqual({
      count: REPEAT_CALL_TERMINATION_CEILING,
      shouldNudge: true,
      severity: "terminate",
    });
    expect(tracker.hasReachedTerminationCeiling()).toBe(true);
  });

  it("resets the counter (and termination) when a different call interleaves", () => {
    const tracker = new ToolCallRepeatTracker();
    const args = { q: "stuck" };

    for (let i = 0; i < REPEAT_CALL_TERMINATION_CEILING; i++) {
      tracker.record("search", args);
    }
    expect(tracker.hasReachedTerminationCeiling()).toBe(true);

    // A different tool resets, so the next "search" starts a fresh streak.
    expect(tracker.record("other_tool", {})).toEqual({
      count: 1,
      shouldNudge: false,
      severity: "none",
    });
    expect(tracker.hasReachedTerminationCeiling()).toBe(false);
    expect(tracker.record("search", args)).toEqual({
      count: 1,
      shouldNudge: false,
      severity: "none",
    });
  });

  it("treats different arguments as a different call", () => {
    const tracker = new ToolCallRepeatTracker();
    for (let i = 0; i < MAX_IDENTICAL_TOOL_CALLS; i++) {
      tracker.record("read_file", { path: "/a" });
    }
    expect(tracker.record("read_file", { path: "/b" })).toEqual({
      count: 1,
      shouldNudge: false,
      severity: "none",
    });
  });

  it("fingerprints argument objects independent of key order", () => {
    const tracker = new ToolCallRepeatTracker();
    tracker.record("call", { a: 1, b: { c: 2, d: 3 } });
    tracker.record("call", { b: { d: 3, c: 2 }, a: 1 });
    const third = tracker.record("call", { b: { d: 3, c: 2 }, a: 1 });
    expect(third.count).toBe(3);
  });

  it("lets the first retry run, then nudges on the second repeat after a deterministic error", () => {
    const tracker = new ToolCallRepeatTracker();
    const args = { appId: "x", baseVersion: 1, edits: [] };

    // First call executes; the dispatcher marks it a deterministic error.
    expect(tracker.record("edit_app", args).severity).toBe("none");
    tracker.noteDeterministicError("edit_app", args);

    // The first identical retry still executes (covers a one-off transient) ...
    expect(tracker.record("edit_app", args).severity).toBe("none");
    // ... but the second consecutive retry is nudged, a step before the
    // standard threshold (which would be count 4).
    expect(tracker.record("edit_app", args)).toEqual({
      count: 3,
      shouldNudge: true,
      severity: "nudge",
    });
  });

  it("only fast-nudges the exact call that errored, not a different one", () => {
    const tracker = new ToolCallRepeatTracker();
    tracker.record("edit_app", { a: 1 });
    tracker.noteDeterministicError("edit_app", { a: 1 });

    // A different call is unaffected by the prior error flag, even when
    // repeated past the point where the errored call would have been nudged.
    expect(tracker.record("read_app", { a: 1 }).severity).toBe("none");
    expect(tracker.record("read_app", { a: 1 }).severity).toBe("none");
    expect(tracker.record("read_app", { a: 1 }).severity).toBe("none");
  });

  it("does not fast-nudge a successful call repeated identically", () => {
    const tracker = new ToolCallRepeatTracker();
    const args = { path: "/a" };
    // No noteDeterministicError: a clean repeat keeps the standard threshold.
    expect(tracker.record("read_file", args).severity).toBe("none");
    expect(tracker.record("read_file", args).severity).toBe("none");
    expect(tracker.record("read_file", args).severity).toBe("none");
  });

  it("does not fast-nudge after a non-consecutive re-issue of a failed call", () => {
    const tracker = new ToolCallRepeatTracker();
    const failed = { appId: "x", edits: [] };
    tracker.record("edit_app", failed);
    tracker.noteDeterministicError("edit_app", failed);
    // An intervening different call breaks the consecutive streak ...
    tracker.record("read_app", { appId: "x" });
    // ... so re-issuing the once-failed call starts fresh and executes.
    expect(tracker.record("edit_app", failed).severity).toBe("none");
  });

  it("handles undefined arguments without throwing", () => {
    const tracker = new ToolCallRepeatTracker();
    expect(tracker.record("noop", undefined)).toEqual({
      count: 1,
      shouldNudge: false,
      severity: "none",
    });
    expect(tracker.record("noop", undefined).count).toBe(2);
  });
});

describe("repeatCeilingStopCondition", () => {
  it("fires only once the bound tracker reaches the ceiling", () => {
    const tracker = new ToolCallRepeatTracker();
    const stop = repeatCeilingStopCondition(tracker);
    const noSteps = { steps: [] } as unknown as Parameters<typeof stop>[0];

    for (let i = 1; i < REPEAT_CALL_TERMINATION_CEILING; i++) {
      tracker.record("run_tool", {});
      expect(stop(noSteps)).toBe(false);
    }
    tracker.record("run_tool", {});
    expect(stop(noSteps)).toBe(true);
  });
});
