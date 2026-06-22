import { describe, expect, it } from "vitest";
import {
  MAX_IDENTICAL_TOOL_CALLS,
  ToolCallRepeatTracker,
} from "./tool-call-repeat-tracker";

describe("ToolCallRepeatTracker", () => {
  it("counts consecutive identical calls and nudges only past the threshold", () => {
    const tracker = new ToolCallRepeatTracker();
    const args = { path: "/tmp/x" };

    for (let i = 1; i <= MAX_IDENTICAL_TOOL_CALLS; i++) {
      const record = tracker.record("read_file", args);
      expect(record).toEqual({ count: i, shouldNudge: false });
    }

    const overThreshold = tracker.record("read_file", args);
    expect(overThreshold).toEqual({
      count: MAX_IDENTICAL_TOOL_CALLS + 1,
      shouldNudge: true,
    });
  });

  it("resets the counter when a different call interleaves", () => {
    const tracker = new ToolCallRepeatTracker();
    const args = { q: "stuck" };

    for (let i = 0; i < MAX_IDENTICAL_TOOL_CALLS + 2; i++) {
      tracker.record("search", args);
    }
    expect(tracker.record("search", args).shouldNudge).toBe(true);

    // A different tool resets, so the next "search" starts a fresh streak.
    expect(tracker.record("other_tool", {}).shouldNudge).toBe(false);
    expect(tracker.record("search", args)).toEqual({
      count: 1,
      shouldNudge: false,
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
    });
  });

  it("fingerprints argument objects independent of key order", () => {
    const tracker = new ToolCallRepeatTracker();
    tracker.record("call", { a: 1, b: { c: 2, d: 3 } });
    tracker.record("call", { b: { d: 3, c: 2 }, a: 1 });
    const third = tracker.record("call", { b: { d: 3, c: 2 }, a: 1 });
    expect(third.count).toBe(3);
  });

  it("handles undefined arguments without throwing", () => {
    const tracker = new ToolCallRepeatTracker();
    expect(tracker.record("noop", undefined)).toEqual({
      count: 1,
      shouldNudge: false,
    });
    expect(tracker.record("noop", undefined).count).toBe(2);
  });
});
