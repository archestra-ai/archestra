import { describe, expect, test } from "vitest";
import {
  isRetryableEmptyFinishReason,
  probeFirstRenderableEvent,
  type StreamProbeEvent,
} from "./stream-probe";

// builds a real async iterator over the given events; `onReturn` records whether
// the iterator was cancelled (which would cancel the underlying stream).
function iteratorOf(
  events: StreamProbeEvent[],
  onReturn?: () => void,
): AsyncIterator<StreamProbeEvent> {
  let index = 0;
  return {
    next() {
      if (index < events.length) {
        return Promise.resolve({ value: events[index++], done: false });
      }
      return Promise.resolve({ value: undefined, done: true });
    },
    return() {
      onReturn?.();
      return Promise.resolve({ value: undefined, done: true });
    },
  };
}

describe("probeFirstRenderableEvent", () => {
  test("returns renderable on the first text-delta", async () => {
    const events: StreamProbeEvent[] = [
      { type: "start" },
      { type: "start-step" },
      { type: "text-start" },
      { type: "text-delta" },
      { type: "finish", finishReason: "stop" },
    ];

    expect(await probeFirstRenderableEvent(iteratorOf(events))).toEqual({
      kind: "renderable",
    });
  });

  test("treats a tool-only turn as renderable, not empty", async () => {
    const events: StreamProbeEvent[] = [
      { type: "start" },
      { type: "start-step" },
      { type: "tool-input-start" },
      { type: "tool-call" },
      { type: "finish", finishReason: "tool-calls" },
    ];

    expect(await probeFirstRenderableEvent(iteratorOf(events))).toEqual({
      kind: "renderable",
    });
  });

  test("treats a resume turn opening with tool-output-denied as renderable", async () => {
    const events: StreamProbeEvent[] = [
      { type: "start" },
      { type: "start-step" },
      { type: "tool-output-denied" },
      { type: "finish", finishReason: "stop" },
    ];

    expect(await probeFirstRenderableEvent(iteratorOf(events))).toEqual({
      kind: "renderable",
    });
  });

  test("treats a tool-error opening as renderable", async () => {
    const events: StreamProbeEvent[] = [
      { type: "start" },
      { type: "tool-error" },
      { type: "finish", finishReason: "stop" },
    ];

    expect(await probeFirstRenderableEvent(iteratorOf(events))).toEqual({
      kind: "renderable",
    });
  });

  test("treats a reasoning-only opening as renderable", async () => {
    const events: StreamProbeEvent[] = [
      { type: "start" },
      { type: "reasoning-start" },
    ];

    expect(await probeFirstRenderableEvent(iteratorOf(events))).toEqual({
      kind: "renderable",
    });
  });

  test("reports empty with finishReason when the turn finishes with no content", async () => {
    const events: StreamProbeEvent[] = [
      { type: "start" },
      { type: "start-step" },
      { type: "finish-step", finishReason: "stop" },
      { type: "finish", finishReason: "stop" },
    ];

    expect(await probeFirstRenderableEvent(iteratorOf(events))).toEqual({
      kind: "empty",
      finishReason: "stop",
    });
  });

  test("surfaces the provider's raw finish reason on an empty error finish", async () => {
    const events: StreamProbeEvent[] = [
      { type: "start" },
      { type: "start-step" },
      {
        type: "finish-step",
        finishReason: "error",
        rawFinishReason: "MALFORMED_FUNCTION_CALL",
      },
      {
        type: "finish",
        finishReason: "error",
        rawFinishReason: "MALFORMED_FUNCTION_CALL",
      },
    ];

    expect(await probeFirstRenderableEvent(iteratorOf(events))).toEqual({
      kind: "empty",
      finishReason: "error",
      rawFinishReason: "MALFORMED_FUNCTION_CALL",
    });
  });

  test("reports empty with unknown when the stream ends without a finish event", async () => {
    const events: StreamProbeEvent[] = [{ type: "start" }];

    expect(await probeFirstRenderableEvent(iteratorOf(events))).toEqual({
      kind: "empty",
      finishReason: "unknown",
    });
  });

  test("surfaces an error event before any content", async () => {
    const boom = new Error("provider exploded");
    const events: StreamProbeEvent[] = [
      { type: "start" },
      { type: "error", error: boom },
    ];

    expect(await probeFirstRenderableEvent(iteratorOf(events))).toEqual({
      kind: "error",
      error: boom,
    });
  });

  test("surfaces a thrown error from the iterator", async () => {
    const boom = new Error("context length exceeded");
    const iterator: AsyncIterator<StreamProbeEvent> = {
      next() {
        return Promise.reject(boom);
      },
    };

    expect(await probeFirstRenderableEvent(iterator)).toEqual({
      kind: "error",
      error: boom,
    });
  });

  test("reports aborted when the stream is aborted before content", async () => {
    const events: StreamProbeEvent[] = [
      { type: "start" },
      { type: "abort", reason: "user stopped" } as StreamProbeEvent,
    ];

    expect(await probeFirstRenderableEvent(iteratorOf(events))).toEqual({
      kind: "aborted",
    });
  });

  test("does not cancel the iterator when it finds content (so the merge can replay)", async () => {
    let returned = false;
    const events: StreamProbeEvent[] = [
      { type: "start" },
      { type: "text-delta" },
      { type: "finish", finishReason: "stop" },
    ];

    await probeFirstRenderableEvent(
      iteratorOf(events, () => {
        returned = true;
      }),
    );

    expect(returned).toBe(false);
  });
});

describe("isRetryableEmptyFinishReason", () => {
  test("retries on stop, length, unknown, error, and other", () => {
    expect(isRetryableEmptyFinishReason("stop")).toBe(true);
    expect(isRetryableEmptyFinishReason("length")).toBe(true);
    expect(isRetryableEmptyFinishReason("unknown")).toBe(true);
    expect(isRetryableEmptyFinishReason("error")).toBe(true);
    expect(isRetryableEmptyFinishReason("other")).toBe(true);
  });

  test("does not retry on deterministic terminal reasons", () => {
    expect(isRetryableEmptyFinishReason("content-filter")).toBe(false);
    expect(isRetryableEmptyFinishReason("tool-calls")).toBe(false);
  });
});
