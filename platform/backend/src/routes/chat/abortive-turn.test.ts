import type { UIMessageChunk } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createAbortiveTurnTracker } from "./abortive-turn";

const SENTINEL_ERROR: UIMessageChunk = {
  type: "error",
  errorText: "abortive",
};

async function drainThroughTracker(
  chunks: UIMessageChunk[],
  onUnresolvedToolCall: () => UIMessageChunk | null,
): Promise<UIMessageChunk[]> {
  const tracker = createAbortiveTurnTracker({ onUnresolvedToolCall });
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

const toolInputStart = (toolCallId: string): UIMessageChunk => ({
  type: "tool-input-start",
  toolCallId,
  toolName: "search",
});
const toolInputDelta = (toolCallId: string): UIMessageChunk => ({
  type: "tool-input-delta",
  toolCallId,
  inputTextDelta: "{",
});
const toolInputAvailable = (toolCallId: string): UIMessageChunk => ({
  type: "tool-input-available",
  toolCallId,
  toolName: "search",
  input: {},
});

describe("createAbortiveTurnTracker", () => {
  test("appends the error chunk when a tool call's input never completed", async () => {
    const onUnresolvedToolCall = vi.fn(() => SENTINEL_ERROR);
    const out = await drainThroughTracker(
      [
        { type: "text-start", id: "t0" },
        toolInputStart("call-1"),
        toolInputDelta("call-1"),
      ],
      onUnresolvedToolCall,
    );

    expect(onUnresolvedToolCall).toHaveBeenCalledTimes(1);
    // model chunks forwarded unchanged, error appended last
    expect(out.map((c) => c.type)).toEqual([
      "text-start",
      "tool-input-start",
      "tool-input-delta",
      "error",
    ]);
  });

  test("does not fire when a tool call reached tool-input-available", async () => {
    const onUnresolvedToolCall = vi.fn(() => SENTINEL_ERROR);
    const out = await drainThroughTracker(
      [
        toolInputStart("call-1"),
        toolInputDelta("call-1"),
        toolInputAvailable("call-1"),
        { type: "tool-output-available", toolCallId: "call-1", output: "ok" },
      ],
      onUnresolvedToolCall,
    );

    expect(onUnresolvedToolCall).not.toHaveBeenCalled();
    expect(out.some((c) => c.type === "error")).toBe(false);
  });

  test("does not fire for an approval/elicitation pause (input completed first)", async () => {
    const onUnresolvedToolCall = vi.fn(() => SENTINEL_ERROR);
    await drainThroughTracker(
      [toolInputStart("call-1"), toolInputAvailable("call-1")],
      onUnresolvedToolCall,
    );
    expect(onUnresolvedToolCall).not.toHaveBeenCalled();
  });

  test("does not fire when the tool input itself errored (tool-input-error)", async () => {
    const onUnresolvedToolCall = vi.fn(() => SENTINEL_ERROR);
    await drainThroughTracker(
      [
        toolInputStart("call-1"),
        toolInputDelta("call-1"),
        {
          type: "tool-input-error",
          toolCallId: "call-1",
          toolName: "search",
          input: {},
          errorText: "bad input",
        },
      ],
      onUnresolvedToolCall,
    );
    expect(onUnresolvedToolCall).not.toHaveBeenCalled();
  });

  test("does not fire for a plain text turn with no tool calls", async () => {
    const onUnresolvedToolCall = vi.fn(() => SENTINEL_ERROR);
    await drainThroughTracker(
      [
        { type: "text-start", id: "t0" },
        { type: "text-delta", id: "t0", delta: "hello" },
        { type: "text-end", id: "t0" },
      ],
      onUnresolvedToolCall,
    );
    expect(onUnresolvedToolCall).not.toHaveBeenCalled();
  });

  test("fires when one of several tool calls is abandoned", async () => {
    const onUnresolvedToolCall = vi.fn(() => SENTINEL_ERROR);
    await drainThroughTracker(
      [
        toolInputStart("call-1"),
        toolInputAvailable("call-1"),
        toolInputStart("call-2"),
        toolInputDelta("call-2"),
      ],
      onUnresolvedToolCall,
    );
    expect(onUnresolvedToolCall).toHaveBeenCalledTimes(1);
  });

  test("appends nothing when the callback declines (aborted/already-errored)", async () => {
    const onUnresolvedToolCall = vi.fn(() => null);
    const out = await drainThroughTracker(
      [toolInputStart("call-1"), toolInputDelta("call-1")],
      onUnresolvedToolCall,
    );
    expect(onUnresolvedToolCall).toHaveBeenCalledTimes(1);
    expect(out.some((c) => c.type === "error")).toBe(false);
  });
});
