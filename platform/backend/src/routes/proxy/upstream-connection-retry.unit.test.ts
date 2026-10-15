import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  openUpstreamWithRetry,
  withFirstChunk,
} from "./upstream-connection-retry";

describe("openUpstreamWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns a successful initial response without scheduling retries", async () => {
    const response = { content: "answer" };
    const open = vi.fn().mockResolvedValue(response);
    const onRetry = vi.fn();

    await expect(
      openUpstreamWithRetry({
        open,
        isRetryable: () => true,
        shouldContinue: () => true,
        onRetry,
      }),
    ).resolves.toBe(response);
    expect(open).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("waits 250ms then 1000ms before returning the third attempt's response", async () => {
    const firstError = new Error("connection reset");
    const secondError = new Error("connection refused");
    const response = { content: "recovered" };
    const open = vi
      .fn()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(secondError)
      .mockResolvedValue(response);
    const onRetry = vi.fn();
    const result = openUpstreamWithRetry({
      open,
      isRetryable: () => true,
      shouldContinue: () => true,
      onRetry,
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(open).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe(response);
    expect(open).toHaveBeenCalledTimes(3);
    expect(onRetry.mock.calls).toEqual([
      [{ attempt: 1, delayMs: 250, error: firstError }],
      [{ attempt: 2, delayMs: 1000, error: secondError }],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("exhausts two retries and preserves the final transport error", async () => {
    const finalError = new Error("last connection reset");
    const open = vi
      .fn()
      .mockRejectedValueOnce(new Error("first connection reset"))
      .mockRejectedValueOnce(new Error("second connection reset"))
      .mockRejectedValue(finalError);
    const onRetry = vi.fn();
    const result = openUpstreamWithRetry({
      open,
      isRetryable: () => true,
      shouldContinue: () => true,
      onRetry,
    });
    const rejected = expect(result).rejects.toBe(finalError);

    await vi.runAllTimersAsync();
    await rejected;
    expect(open).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("does not retry a nonretryable error after a transport retry", async () => {
    const providerError = new Error("provider rejected the request");
    const transportError = new Error("connection reset");
    const open = vi
      .fn()
      .mockRejectedValueOnce(transportError)
      .mockRejectedValue(providerError);
    const isRetryable = (error: unknown) => error === transportError;
    const onRetry = vi.fn();
    const result = openUpstreamWithRetry({
      open,
      isRetryable,
      shouldContinue: () => true,
      onRetry,
    });
    const rejected = expect(result).rejects.toBe(providerError);

    await vi.runAllTimersAsync();
    await rejected;
    expect(open).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("propagates a nonretryable initial error without backoff", async () => {
    const error = new Error("invalid request");
    const open = vi.fn().mockRejectedValue(error);
    const onRetry = vi.fn();

    await expect(
      openUpstreamWithRetry({
        open,
        isRetryable: () => false,
        shouldContinue: () => true,
        onRetry,
      }),
    ).rejects.toBe(error);
    expect(open).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("does not open an upstream call for an already disconnected client", async () => {
    const open = vi.fn().mockResolvedValue("unwanted response");

    await expect(
      openUpstreamWithRetry({
        open,
        isRetryable: () => true,
        shouldContinue: () => false,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(open).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("does not schedule a retry when the client disconnects during the failed attempt", async () => {
    const error = new Error("connection reset");
    let connected = true;
    const open = vi.fn(async () => {
      connected = false;
      throw error;
    });
    const onRetry = vi.fn();

    await expect(
      openUpstreamWithRetry({
        open,
        isRetryable: () => true,
        shouldContinue: () => connected,
        onRetry,
      }),
    ).rejects.toBe(error);
    expect(open).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("does not reopen upstream when the client disconnects during backoff", async () => {
    const error = new Error("connection reset");
    const open = vi.fn().mockRejectedValue(error);
    let connected = true;
    const result = openUpstreamWithRetry({
      open,
      isRetryable: () => true,
      shouldContinue: () => connected,
    });
    const rejected = expect(result).rejects.toBe(error);

    await vi.advanceTimersByTimeAsync(100);
    connected = false;
    await vi.runAllTimersAsync();
    await rejected;
    expect(open).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("honors an empty retry budget", async () => {
    const error = new Error("connection reset");
    const open = vi.fn().mockRejectedValue(error);

    await expect(
      openUpstreamWithRetry({
        open,
        isRetryable: () => true,
        shouldContinue: () => true,
        delaysMs: [],
      }),
    ).rejects.toBe(error);
    expect(open).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("retries a failed first read before exposing any stream chunks", async () => {
    const error = new Error("connection reset");
    const failedIterator = {
      next: vi
        .fn<() => Promise<IteratorResult<string>>>()
        .mockRejectedValue(error),
      return: vi.fn().mockResolvedValue({ done: true }),
    };
    const failedStream = { [Symbol.asyncIterator]: () => failedIterator };
    const open = vi
      .fn<() => Promise<AsyncIterable<string>>>()
      .mockImplementationOnce(() => withFirstChunk(failedStream))
      .mockImplementation(() =>
        withFirstChunk(
          (async function* () {
            yield "first";
            yield "second";
          })(),
        ),
      );
    const result = openUpstreamWithRetry({
      open,
      isRetryable: (failure) => failure === error,
      shouldContinue: () => true,
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const chunks: string[] = [];
    for await (const chunk of await result) chunks.push(chunk);

    expect(chunks).toEqual(["first", "second"]);
    expect(open).toHaveBeenCalledTimes(2);
    expect(failedIterator.return).toHaveBeenCalledTimes(1);
  });

  test("never reopens a stream that fails after its first chunk", async () => {
    const error = new Error("connection reset mid-stream");
    const open = vi.fn(() =>
      withFirstChunk(
        (async function* () {
          yield "already delivered";
          throw error;
        })(),
      ),
    );
    const onRetry = vi.fn();
    const stream = await openUpstreamWithRetry({
      open,
      isRetryable: () => true,
      shouldContinue: () => true,
      onRetry,
    });
    const chunks: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of stream) chunks.push(chunk);
      })(),
    ).rejects.toBe(error);
    await vi.runAllTimersAsync();

    expect(chunks).toEqual(["already delivered"]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("withFirstChunk", () => {
  test("prefetches exactly one chunk and replays every chunk once in order", async () => {
    const next = vi
      .fn<() => Promise<IteratorResult<string>>>()
      .mockResolvedValueOnce({ value: "first", done: false })
      .mockResolvedValueOnce({ value: "second", done: false })
      .mockResolvedValue({ value: undefined, done: true });
    const stream = await withFirstChunk({
      [Symbol.asyncIterator]: () => ({ next }),
    });
    expect(next).toHaveBeenCalledTimes(1);

    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks).toEqual(["first", "second"]);
    expect(next).toHaveBeenCalledTimes(3);
    expect(() => stream[Symbol.asyncIterator]()).toThrow(/only once/);
  });

  test("does not yield a chunk or read again when prefetch finds an empty stream", async () => {
    const next = vi.fn().mockResolvedValue({ done: true });
    const close = vi.fn();
    const stream = await withFirstChunk({
      [Symbol.asyncIterator]: () => ({ next, return: close }),
    });
    const chunks: unknown[] = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks).toEqual([]);
    expect(next).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  test.each([
    false,
    true,
  ])("closes a failed prefetch and preserves its error when cleanup rejects: %s", async (cleanupRejects) => {
    const error = new Error("connection reset before first chunk");
    const next = vi.fn().mockRejectedValue(error);
    const close = cleanupRejects
      ? vi.fn().mockRejectedValue(new Error("cleanup failed"))
      : vi.fn().mockResolvedValue({ done: true });

    await expect(
      withFirstChunk({
        [Symbol.asyncIterator]: () => ({ next, return: close }),
      }),
    ).rejects.toBe(error);
    expect(next).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("closes upstream when the consumer stops after the prefetched chunk", async () => {
    let closed = false;
    const upstream = (async function* () {
      try {
        yield "first";
        yield "must not be read";
      } finally {
        closed = true;
      }
    })();
    const stream = await withFirstChunk(upstream);
    const chunks: string[] = [];

    for await (const chunk of stream) {
      chunks.push(chunk);
      break;
    }

    expect(chunks).toEqual(["first"]);
    expect(closed).toBe(true);
  });
});
