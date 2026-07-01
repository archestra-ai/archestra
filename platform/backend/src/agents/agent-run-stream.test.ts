import { type ModelMessage, simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import { EmptyModelResponseError } from "@/routes/chat/errors";
import {
  isRetryableEmptyFinishReason,
  probeFirstRenderableEvent,
  runAgentStream,
  type StreamProbeEvent,
} from "./agent-run-stream";

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

  test("reports abortive when a tool call starts but the turn finishes without a tool-call", async () => {
    const events: StreamProbeEvent[] = [
      { type: "start" },
      { type: "start-step" },
      { type: "tool-input-start" },
      { type: "tool-input-delta" },
      { type: "finish-step", finishReason: "tool-calls" },
      { type: "finish", finishReason: "tool-calls" },
    ];

    expect(await probeFirstRenderableEvent(iteratorOf(events))).toEqual({
      kind: "abortive",
      finishReason: "tool-calls",
    });
  });

  test("reports abortive when a tool-input stream ends without any finish event", async () => {
    const events: StreamProbeEvent[] = [
      { type: "start" },
      { type: "tool-input-start" },
      { type: "tool-input-delta" },
    ];

    expect(await probeFirstRenderableEvent(iteratorOf(events))).toEqual({
      kind: "abortive",
      finishReason: "unknown",
    });
  });

  test("a completed tool call after tool-input streaming is renderable, not abortive", async () => {
    const events: StreamProbeEvent[] = [
      { type: "start" },
      { type: "tool-input-start" },
      { type: "tool-input-delta" },
      { type: "tool-input-end" },
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
  test("does not retry on deterministic terminal reasons", () => {
    expect(isRetryableEmptyFinishReason("content-filter")).toBe(false);
    expect(isRetryableEmptyFinishReason("tool-calls")).toBe(false);
  });
});

// A `LanguageModelV3StreamResult` (one per simulated doStream call). The mock
// model is the only mocked boundary — real `streamText` drives the recovery.
type StreamResult = Extract<
  NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>["doStream"],
  { stream: unknown }
>;
type ModelStreamPart =
  StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

function streamResult(chunks: ModelStreamPart[]): StreamResult {
  return { stream: simulateReadableStream({ chunks }) };
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function finished(unified: "stop" | "tool-calls" | "error") {
  return { unified, raw: unified };
}

function renderableChunks(): ModelStreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "1" },
    { type: "text-delta", id: "1", delta: "hi" },
    { type: "text-end", id: "1" },
    { type: "finish", finishReason: finished("stop"), usage },
  ];
}

function emptyChunks(): ModelStreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "finish", finishReason: finished("stop"), usage },
  ];
}

function abortiveChunks(): ModelStreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "t1", toolName: "foo" },
    { type: "tool-input-delta", id: "t1", delta: "{" },
    { type: "finish", finishReason: finished("tool-calls"), usage },
  ];
}

function errorChunks(error: Error): ModelStreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "error", error },
    { type: "finish", finishReason: finished("error"), usage },
  ];
}

// drains the returned stream's fullStream so simulated streams don't leak.
async function drain(result: { fullStream: AsyncIterable<unknown> }) {
  for await (const _ of result.fullStream) {
    // no-op
  }
}

// Returns a fresh simulated stream per `doStream` call (a single-use
// ReadableStream cannot be replayed across attempts). Calls past the provided
// list reuse the last entry so an unexpected extra attempt fails loudly on the
// assertion rather than on stream exhaustion.
function modelFor(...calls: ModelStreamPart[][]): MockLanguageModelV3 {
  let attempt = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const chunks = calls[Math.min(attempt, calls.length - 1)];
      attempt++;
      return streamResult(chunks);
    },
  });
}

describe("runAgentStream", () => {
  test("returns immediately on a renderable first event, without retrying", async () => {
    const model = modelFor(renderableChunks());

    const { result } = await runAgentStream({
      config: { model, prompt: "hello" },
    });
    await drain(result);

    expect(model.doStreamCalls).toHaveLength(1);
    expect(await result.text).toBe("hi");
  });

  test("retries an empty response to the cap, then throws EmptyModelResponseError", async () => {
    const model = modelFor(emptyChunks(), emptyChunks(), emptyChunks());
    const onEmptyResponseExhausted = vi.fn(async () => {});

    await expect(
      runAgentStream({
        config: { model, prompt: "hello" },
        recovery: { onEmptyResponseExhausted },
      }),
    ).rejects.toBeInstanceOf(EmptyModelResponseError);

    expect(model.doStreamCalls).toHaveLength(3);
    expect(onEmptyResponseExhausted).toHaveBeenCalledTimes(1);
  });

  test("retries an empty response, then commits the renderable retry", async () => {
    const model = modelFor(emptyChunks(), renderableChunks());

    const { result } = await runAgentStream({
      config: { model, prompt: "hello" },
    });
    await drain(result);

    expect(model.doStreamCalls).toHaveLength(2);
    expect(await result.text).toBe("hi");
  });

  test("retries an abortive tool call, then surfaces the abortive result on exhaustion", async () => {
    const model = modelFor(abortiveChunks(), abortiveChunks());

    const { result } = await runAgentStream({
      config: { model, prompt: "hello" },
    });
    await drain(result);

    expect(model.doStreamCalls).toHaveLength(2);
  });

  test("trims and retries on a context-length rejection when messages are present", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "a".repeat(400) },
      { role: "assistant", content: "b".repeat(400) },
      { role: "user", content: "c".repeat(400) },
    ];
    const model = modelFor(
      errorChunks(new Error("maximum input length of 5 tokens")),
      renderableChunks(),
    );

    const { result } = await runAgentStream({
      config: { model, messages },
    });
    await drain(result);

    expect(model.doStreamCalls).toHaveLength(2);
    // the retry resends a trimmed (shorter) message list
    expect(model.doStreamCalls[1].prompt.length).toBeLessThan(
      model.doStreamCalls[0].prompt.length,
    );
    expect(await result.text).toBe("hi");
  });

  test("does not trim a prompt-only run; returns the errored result for the merge", async () => {
    const contextError = new Error("maximum input length of 5 tokens");
    const model = modelFor(errorChunks(contextError));

    const { result, getCapturedStreamError } = await runAgentStream({
      config: { model, prompt: "hello" },
    });
    await drain(result);

    expect(model.doStreamCalls).toHaveLength(1);
    expect(getCapturedStreamError()).toBe(contextError);
  });

  test("getCapturedStreamError reflects only the committed attempt (discarded retry cleared)", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "a".repeat(400) },
      { role: "assistant", content: "b".repeat(400) },
      { role: "user", content: "c".repeat(400) },
    ];
    const model = modelFor(
      errorChunks(new Error("maximum input length of 5 tokens")),
      renderableChunks(),
    );

    const { result, getCapturedStreamError } = await runAgentStream({
      config: { model, messages },
    });
    await drain(result);

    // the discarded trim attempt errored; the committed attempt was clean, so
    // the capture must not leak the discarded attempt's error.
    expect(getCapturedStreamError()).toBeUndefined();
  });

  test("chains the injected onError to a caller-provided onError", async () => {
    const contextError = new Error("maximum input length of 5 tokens");
    const callerOnError = vi.fn();
    const model = modelFor(errorChunks(contextError));

    const { result } = await runAgentStream({
      config: { model, prompt: "hello", onError: callerOnError },
    });
    await drain(result);

    expect(callerOnError).toHaveBeenCalledWith({ error: contextError });
  });
});
