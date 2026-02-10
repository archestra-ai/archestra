import { describe, expect, it } from "vitest";
import { subagentExecutionTracker } from "./subagent-execution-tracker";

describe("SubagentExecutionTracker", () => {
  const key = "test-conversation-id";

  it("should report no active subagents initially", () => {
    expect(subagentExecutionTracker.hasActiveSubagents(key)).toBe(false);
  });

  it("should track a single subagent", () => {
    subagentExecutionTracker.increment(key);
    expect(subagentExecutionTracker.hasActiveSubagents(key)).toBe(true);

    subagentExecutionTracker.decrement(key);
    expect(subagentExecutionTracker.hasActiveSubagents(key)).toBe(false);
  });

  it("should handle concurrent subagents with refcounting", () => {
    subagentExecutionTracker.increment(key);
    subagentExecutionTracker.increment(key);
    expect(subagentExecutionTracker.hasActiveSubagents(key)).toBe(true);

    // First subagent finishes — still one active
    subagentExecutionTracker.decrement(key);
    expect(subagentExecutionTracker.hasActiveSubagents(key)).toBe(true);

    // Second subagent finishes — none active
    subagentExecutionTracker.decrement(key);
    expect(subagentExecutionTracker.hasActiveSubagents(key)).toBe(false);
  });

  it("should isolate different conversations", () => {
    const keyA = "conversation-a";
    const keyB = "conversation-b";

    subagentExecutionTracker.increment(keyA);
    expect(subagentExecutionTracker.hasActiveSubagents(keyA)).toBe(true);
    expect(subagentExecutionTracker.hasActiveSubagents(keyB)).toBe(false);

    subagentExecutionTracker.increment(keyB);
    expect(subagentExecutionTracker.hasActiveSubagents(keyA)).toBe(true);
    expect(subagentExecutionTracker.hasActiveSubagents(keyB)).toBe(true);

    subagentExecutionTracker.decrement(keyA);
    expect(subagentExecutionTracker.hasActiveSubagents(keyA)).toBe(false);
    expect(subagentExecutionTracker.hasActiveSubagents(keyB)).toBe(true);

    subagentExecutionTracker.decrement(keyB);
    expect(subagentExecutionTracker.hasActiveSubagents(keyB)).toBe(false);
  });

  it("should handle decrement on non-existent key gracefully", () => {
    subagentExecutionTracker.decrement("non-existent");
    expect(subagentExecutionTracker.hasActiveSubagents("non-existent")).toBe(
      false,
    );
  });

  it("should handle extra decrements without going negative", () => {
    const extraKey = "extra-decrement";
    subagentExecutionTracker.increment(extraKey);
    subagentExecutionTracker.decrement(extraKey);
    subagentExecutionTracker.decrement(extraKey); // extra decrement
    expect(subagentExecutionTracker.hasActiveSubagents(extraKey)).toBe(false);
  });
});
