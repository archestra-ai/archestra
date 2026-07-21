import type { UIMessageChunk } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createReasoningOnlyTurnTracker } from "./reasoning-only-turn";

const SENTINEL_ERROR: UIMessageChunk = {
  type: "error",
  errorText: "reasoning-only",
};

async function drainThroughTracker(
  chunks: UIMessageChunk[],
  onReasoningOnlyTurn: () => UIMessageChunk | null,
): Promise<UIMessageChunk[]> {
  const tracker = createReasoningOnlyTurnTracker({ onReasoningOnlyTurn });
  const source = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

  const out: UIMessageChunk[] = [];
  const reader = source.pipeThrough(tracker).getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

const reasoningStart: UIMessageChunk = { type: "reasoning-start", id: "r-0" };
const reasoningDelta: UIMessageChunk = {
  type: "reasoning-delta",
  id: "r-0",
  delta: "thinking...",
};
const textStart: UIMessageChunk = { type: "text-start", id: "t-0" };
const textDelta: UIMessageChunk = {
  type: "text-delta",
  id: "t-0",
  delta: "answer",
};
const toolInputStart: UIMessageChunk = {
  type: "tool-input-start",
  toolCallId: "tc-0",
  toolName: "search",
};

describe("createReasoningOnlyTurnTracker", () => {
  test("appends the trailing error when the turn is reasoning-only", async () => {
    const onReasoningOnlyTurn = vi.fn(() => SENTINEL_ERROR);

    const out = await drainThroughTracker(
      [reasoningStart, reasoningDelta],
      onReasoningOnlyTurn,
    );

    expect(onReasoningOnlyTurn).toHaveBeenCalledTimes(1);
    expect(out).toEqual([reasoningStart, reasoningDelta, SENTINEL_ERROR]);
  });

  test("does not fire when reasoning is followed by text", async () => {
    const onReasoningOnlyTurn = vi.fn(() => SENTINEL_ERROR);

    const out = await drainThroughTracker(
      [reasoningStart, reasoningDelta, textStart, textDelta],
      onReasoningOnlyTurn,
    );

    expect(onReasoningOnlyTurn).not.toHaveBeenCalled();
    expect(out).toEqual([reasoningStart, reasoningDelta, textStart, textDelta]);
  });

  test("does not fire when reasoning is followed by a tool call", async () => {
    const onReasoningOnlyTurn = vi.fn(() => SENTINEL_ERROR);

    await drainThroughTracker(
      [reasoningStart, reasoningDelta, toolInputStart],
      onReasoningOnlyTurn,
    );

    expect(onReasoningOnlyTurn).not.toHaveBeenCalled();
  });

  test("does not fire when the turn produced no reasoning at all", async () => {
    // A cleanly-empty turn (no reasoning, no answer) is the empty-response
    // probe's job, not this tracker's.
    const onReasoningOnlyTurn = vi.fn(() => SENTINEL_ERROR);

    const out = await drainThroughTracker(
      [textStart, textDelta],
      onReasoningOnlyTurn,
    );

    expect(onReasoningOnlyTurn).not.toHaveBeenCalled();
    expect(out).toEqual([textStart, textDelta]);
  });

  test("appends nothing when the callback returns null (aborted/already errored)", async () => {
    const onReasoningOnlyTurn = vi.fn(() => null);

    const out = await drainThroughTracker(
      [reasoningStart, reasoningDelta],
      onReasoningOnlyTurn,
    );

    expect(onReasoningOnlyTurn).toHaveBeenCalledTimes(1);
    expect(out).toEqual([reasoningStart, reasoningDelta]);
  });
});
