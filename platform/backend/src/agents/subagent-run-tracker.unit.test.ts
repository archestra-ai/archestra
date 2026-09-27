import { describe, expect, it } from "vitest";
import { subagentRunTracker } from "./subagent-run-tracker";

describe("SubagentRunTracker", () => {
  const key = "test-conversation-id";

  it("should report no active subagents initially", () => {
    expect(subagentRunTracker.hasActiveSubagents(key)).toBe(false);
  });

  it("should track a single subagent", () => {
    subagentRunTracker.increment(key);
    expect(subagentRunTracker.hasActiveSubagents(key)).toBe(true);

    subagentRunTracker.decrement(key);
    expect(subagentRunTracker.hasActiveSubagents(key)).toBe(false);
  });

  it("should handle concurrent subagents with refcounting", () => {
    subagentRunTracker.increment(key);
    subagentRunTracker.increment(key);
    expect(subagentRunTracker.hasActiveSubagents(key)).toBe(true);

    // First subagent finishes — still one active
    subagentRunTracker.decrement(key);
    expect(subagentRunTracker.hasActiveSubagents(key)).toBe(true);

    // Second subagent finishes — none active
    subagentRunTracker.decrement(key);
    expect(subagentRunTracker.hasActiveSubagents(key)).toBe(false);
  });

  it("should isolate different conversations", () => {
    const keyA = "conversation-a";
    const keyB = "conversation-b";

    subagentRunTracker.increment(keyA);
    expect(subagentRunTracker.hasActiveSubagents(keyA)).toBe(true);
    expect(subagentRunTracker.hasActiveSubagents(keyB)).toBe(false);

    subagentRunTracker.increment(keyB);
    expect(subagentRunTracker.hasActiveSubagents(keyA)).toBe(true);
    expect(subagentRunTracker.hasActiveSubagents(keyB)).toBe(true);

    subagentRunTracker.decrement(keyA);
    expect(subagentRunTracker.hasActiveSubagents(keyA)).toBe(false);
    expect(subagentRunTracker.hasActiveSubagents(keyB)).toBe(true);

    subagentRunTracker.decrement(keyB);
    expect(subagentRunTracker.hasActiveSubagents(keyB)).toBe(false);
  });

  it("should handle decrement on non-existent key gracefully", () => {
    subagentRunTracker.decrement("non-existent");
    expect(subagentRunTracker.hasActiveSubagents("non-existent")).toBe(false);
  });

  it("should handle extra decrements without going negative", () => {
    const extraKey = "extra-decrement";
    subagentRunTracker.increment(extraKey);
    subagentRunTracker.decrement(extraKey);
    subagentRunTracker.decrement(extraKey); // extra decrement
    expect(subagentRunTracker.hasActiveSubagents(extraKey)).toBe(false);
  });
});
