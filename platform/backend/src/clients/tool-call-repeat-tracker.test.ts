import { InvalidToolInputError, NoSuchToolError } from "ai";
import { describe, expect, it } from "vitest";
import {
  MAX_IDENTICAL_TOOL_CALLS,
  REPEAT_CALL_TERMINATION_CEILING,
  recordUnavailableToolCallStep,
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

describe("recordUnavailableToolCallStep", () => {
  // The shape the SDK puts on a finished step when the model called a tool that
  // is not in the request's tool list: a dynamic tool call flagged invalid,
  // carrying the NoSuchToolError that rejected it.
  function unavailableCall(toolName: string, input: unknown) {
    return {
      type: "tool-call",
      toolCallId: `call-${toolName}-${JSON.stringify(input)}`,
      toolName,
      input,
      dynamic: true,
      invalid: true,
      error: new NoSuchToolError({ toolName, availableTools: ["real_tool"] }),
    };
  }

  function boundTracker() {
    const tracker = new ToolCallRepeatTracker();
    const stop = repeatCeilingStopCondition(tracker);
    return {
      tracker,
      step: (toolCalls: unknown[]) =>
        recordUnavailableToolCallStep(tracker, {
          toolCalls: toolCalls as Parameters<
            typeof recordUnavailableToolCallStep
          >[1]["toolCalls"],
        }),
      stopped: () =>
        stop({ steps: [] } as unknown as Parameters<typeof stop>[0]),
    };
  }

  it("stops a run that keeps calling a tool outside the tool list, even as the arguments change", () => {
    const { step, stopped } = boundTracker();

    // Distinct arguments every step: this call shape is never fingerprinted by
    // a tool wrapper (it has none), and fingerprinting it *with* its arguments
    // would restart the streak on each retry. Neither reaches the ceiling; both
    // spin to MAX_AGENT_STEPS.
    for (let i = 1; i < REPEAT_CALL_TERMINATION_CEILING; i++) {
      step([unavailableCall("ghost_tool", { attempt: i })]);
      expect(stopped()).toBe(false);
    }

    step([unavailableCall("ghost_tool", { attempt: 99 })]);
    expect(stopped()).toBe(true);
  });

  it("counts one step as one attempt however many calls it made", () => {
    const { step, stopped } = boundTracker();

    // A model firing a whole batch at one missing tool has made a single
    // decision. Counting each call would hit the ceiling inside this step and
    // stop the run before the errors it needs to recover ever reach it.
    step(
      Array.from({ length: REPEAT_CALL_TERMINATION_CEILING * 2 }, (_, i) =>
        unavailableCall("ghost_search", { query: `q${i}` }),
      ),
    );

    expect(stopped()).toBe(false);
  });

  it("leaves a valid tool call to the execute wrapper instead of counting it twice", () => {
    const { tracker, step } = boundTracker();

    step([
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "real_tool",
        input: { q: "x" },
      },
    ]);

    // Untouched: the wrapper is what records executed calls, so a count here
    // would inflate every real tool's streak toward the ceiling.
    expect(tracker.record("real_tool", { q: "x" }).count).toBe(1);
  });

  it("ignores an invalid call whose arguments failed to parse", () => {
    const { tracker, step } = boundTracker();

    // `invalid` also covers unparsable arguments for a tool that does exist.
    // That call gets repaired or retried and is fingerprinted by the wrapper
    // once it parses, so recording it here would double-count.
    step([
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "real_tool",
        input: "{ not json",
        dynamic: true,
        invalid: true,
        error: new InvalidToolInputError({
          toolName: "real_tool",
          toolInput: "{ not json",
          cause: new Error("bad json"),
        }),
      },
    ]);

    expect(tracker.record("real_tool", undefined).count).toBe(1);
  });

  it("ignores a step that called no tools at all", () => {
    const { tracker, step } = boundTracker();

    step([]);
    recordUnavailableToolCallStep(tracker, {});

    expect(tracker.record("anything", undefined).count).toBe(1);
  });

  it("still stops a real tool's own streak when a missing tool rides along in every step", () => {
    const { tracker, step, stopped } = boundTracker();

    // The two streaks are recorded from different places in the loop — the
    // execute wrapper for the real call, this hook for the missing one. Sharing
    // one slot would let each reset the other, so neither would ever build, and
    // a run that terminated on the real tool's repeats before would now go all
    // the way to MAX_AGENT_STEPS.
    for (let i = 1; i < REPEAT_CALL_TERMINATION_CEILING; i++) {
      tracker.record("real_tool", { same: true });
      step([unavailableCall("ghost_tool", { i })]);
      expect(stopped()).toBe(false);
    }

    tracker.record("real_tool", { same: true });
    expect(stopped()).toBe(true);
  });

  it("reaches the ceiling when a step names the same missing tools in a different order", () => {
    const { step, stopped } = boundTracker();

    // Same two walls every step, hit in whatever order the model emitted them.
    // Keying on only one of the names would read this as a fresh attempt each
    // time and never terminate — the same escape as fingerprinting arguments.
    for (let i = 1; i < REPEAT_CALL_TERMINATION_CEILING; i++) {
      const batch = [
        unavailableCall("ghost_a", { i }),
        unavailableCall("ghost_b", { i }),
      ];
      step(i % 2 === 0 ? batch.reverse() : batch);
      expect(stopped()).toBe(false);
    }

    step([unavailableCall("ghost_b", {}), unavailableCall("ghost_a", {})]);
    expect(stopped()).toBe(true);
  });

  it("resets the streak when a different unavailable tool interleaves", () => {
    const { step, stopped } = boundTracker();

    for (let i = 1; i < REPEAT_CALL_TERMINATION_CEILING; i++) {
      step([unavailableCall("ghost_tool", {})]);
    }
    // Reaching for a different missing tool is a change of approach, not the
    // same wall — the streak restarts rather than inheriting the count.
    step([unavailableCall("other_ghost", {})]);
    expect(stopped()).toBe(false);

    for (let i = 1; i < REPEAT_CALL_TERMINATION_CEILING; i++) {
      expect(stopped()).toBe(false);
      step([unavailableCall("other_ghost", {})]);
    }
    expect(stopped()).toBe(true);
  });
});
