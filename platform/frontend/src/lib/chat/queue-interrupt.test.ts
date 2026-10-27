// @vitest-environment node
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { getQueueInterruptBlockedReason } from "./queue-interrupt";

describe("queue interrupt safety", () => {
  it.each([
    "input-available",
    "approval-responded",
    "approval-requested",
  ])("holds the queue for a tool in %s", (state) => {
    const messages = [
      {
        id: "assistant",
        role: "assistant",
        parts: [{ type: "tool-write", toolCallId: "call", state, input: {} }],
      },
    ] as UIMessage[];
    expect(
      getQueueInterruptBlockedReason({
        messages,
        hasPendingQuestion: false,
        isCompacting: false,
      }),
    ).toBeTruthy();
  });
  it.each([
    "input-streaming",
    "output-available",
    "output-error",
    "output-denied",
  ])("allows interruption after a tool is %s", (state) => {
    const messages = [
      {
        id: "assistant",
        role: "assistant",
        parts: [{ type: "tool-write", toolCallId: "call", state, input: {} }],
      },
    ] as UIMessage[];
    expect(
      getQueueInterruptBlockedReason({
        messages,
        hasPendingQuestion: false,
        isCompacting: false,
      }),
    ).toBeUndefined();
  });
  it.each([
    { hasPendingQuestion: true, isCompacting: false },
    { hasPendingQuestion: false, isCompacting: true },
  ])("holds during pending question or compaction: %j", (pending) => {
    expect(
      getQueueInterruptBlockedReason({ messages: [], ...pending }),
    ).toBeTruthy();
  });
  it("allows thinking and text streaming", () => {
    const messages: UIMessage[] = [
      {
        id: "assistant",
        role: "assistant",
        parts: [{ type: "reasoning", text: "Working", state: "streaming" }],
      },
    ];
    expect(
      getQueueInterruptBlockedReason({
        messages,
        hasPendingQuestion: false,
        isCompacting: false,
      }),
    ).toBeUndefined();
  });
});
