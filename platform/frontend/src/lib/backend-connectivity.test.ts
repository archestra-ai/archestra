import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBackendConnectivity } from "./backend-connectivity";

describe("useBackendConnectivity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should start in connecting state", () => {
    const checkHealthFn = vi.fn().mockResolvedValue(false);
    const { result } = renderHook(() =>
      useBackendConnectivity({ checkHealthFn, autoStart: false }),
    );

    expect(result.current.status).toBe("connecting");
    expect(result.current.attemptCount).toBe(0);
    expect(result.current.elapsedMs).toBe(0);
  });

  it("should transition to connected on successful first attempt", async () => {
    const checkHealthFn = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() =>
      useBackendConnectivity({ checkHealthFn }),
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.status).toBe("connected");
    expect(checkHealthFn).toHaveBeenCalledTimes(1);
  });

  it("should retry with exponential backoff on failure", async () => {
    let callCount = 0;
    const checkHealthFn = vi.fn().mockImplementation(() => {
      callCount++;
      // Succeed on the 3rd attempt
      return Promise.resolve(callCount >= 3);
    });

    const { result } = renderHook(() =>
      useBackendConnectivity({
        checkHealthFn,
        initialDelayMs: 1000,
        maxDelayMs: 30000,
      }),
    );

    // First attempt happens immediately
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(checkHealthFn).toHaveBeenCalledTimes(1);
    expect(result.current.attemptCount).toBe(1);

    // Wait for first retry (1s delay after first failure)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(checkHealthFn).toHaveBeenCalledTimes(2);
    expect(result.current.attemptCount).toBe(2);

    // Wait for second retry (2s delay after second failure)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(checkHealthFn).toHaveBeenCalledTimes(3);
    expect(result.current.status).toBe("connected");
  });

  it("should respect maxDelayMs for exponential backoff", async () => {
    const checkHealthFn = vi.fn().mockResolvedValue(false);
    const { result } = renderHook(() =>
      useBackendConnectivity({
        checkHealthFn,
        initialDelayMs: 1000,
        maxDelayMs: 4000,
        timeoutMs: 100000,
      }),
    );

    // First attempt
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(checkHealthFn).toHaveBeenCalledTimes(1);

    // 1s delay (1000 * 2^0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(checkHealthFn).toHaveBeenCalledTimes(2);

    // 2s delay (1000 * 2^1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(checkHealthFn).toHaveBeenCalledTimes(3);

    // 4s delay (1000 * 2^2 = 4000, capped at maxDelayMs)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(checkHealthFn).toHaveBeenCalledTimes(4);

    // Next delay should still be 4s (capped at maxDelayMs)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(checkHealthFn).toHaveBeenCalledTimes(5);

    expect(result.current.status).toBe("connecting");
  });

  it("should transition to unreachable after timeout", async () => {
    const checkHealthFn = vi.fn().mockResolvedValue(false);
    const { result } = renderHook(() =>
      useBackendConnectivity({
        checkHealthFn,
        timeoutMs: 3000,
        initialDelayMs: 500,
        maxDelayMs: 1000,
      }),
    );

    // First attempt (immediate)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("connecting");

    // Keep advancing until we exceed the timeout
    // 0ms: attempt 1, fail -> schedule retry in 500ms
    // 500ms: attempt 2, fail -> schedule retry in 1000ms
    // 1500ms: attempt 3, fail -> schedule retry in 1000ms (capped)
    // 2500ms: attempt 4, fail -> schedule retry in 1000ms (capped)
    // 3500ms: attempt 5, elapsed >= 3000ms -> unreachable
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(result.current.status).toBe("unreachable");
  });

  it("should allow manual retry after unreachable", async () => {
    let resolveHealth: ((value: boolean) => void) | null = null;
    const checkHealthFn = vi.fn().mockImplementation(() => {
      return new Promise<boolean>((resolve) => {
        resolveHealth = resolve;
      });
    });

    const { result } = renderHook(() =>
      useBackendConnectivity({
        checkHealthFn,
        timeoutMs: 1500,
        initialDelayMs: 500,
        maxDelayMs: 500,
      }),
    );

    // Let attempts fail until timeout
    // Attempt 1
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      resolveHealth?.(false);
    });

    // Attempt 2
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await act(async () => {
      resolveHealth?.(false);
    });

    // Attempt 3
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await act(async () => {
      resolveHealth?.(false);
    });

    // Attempt 4 - should trigger unreachable since elapsed >= 1500ms
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await act(async () => {
      resolveHealth?.(false);
    });

    expect(result.current.status).toBe("unreachable");

    // Manually retry - this resets state to connecting
    act(() => {
      result.current.retry();
    });

    // The retry call itself sets status to "connecting" synchronously
    // before the async health check starts
    expect(result.current.attemptCount).toBe(0);

    // Now resolve the health check with success
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      resolveHealth?.(true);
    });

    expect(result.current.status).toBe("connected");
  });

  it("should not start automatically when autoStart is false", async () => {
    const checkHealthFn = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() =>
      useBackendConnectivity({ checkHealthFn, autoStart: false }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(checkHealthFn).not.toHaveBeenCalled();
    expect(result.current.status).toBe("connecting");
  });

  it("should start when retry is called with autoStart false", async () => {
    const checkHealthFn = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() =>
      useBackendConnectivity({ checkHealthFn, autoStart: false }),
    );

    await act(async () => {
      result.current.retry();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(checkHealthFn).toHaveBeenCalled();
    expect(result.current.status).toBe("connected");
  });

  it("should track elapsed time correctly", async () => {
    const checkHealthFn = vi.fn().mockResolvedValue(false);
    const { result } = renderHook(() =>
      useBackendConnectivity({
        checkHealthFn,
        timeoutMs: 60000,
        initialDelayMs: 2000,
      }),
    );

    expect(result.current.elapsedMs).toBe(0);

    // Advance time by 1 second (the interval for elapsedMs updates)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(result.current.elapsedMs).toBeGreaterThanOrEqual(1000);
  });

  it("should increment attempt count on each failed attempt", async () => {
    const checkHealthFn = vi.fn().mockResolvedValue(false);
    const { result } = renderHook(() =>
      useBackendConnectivity({
        checkHealthFn,
        initialDelayMs: 100,
        maxDelayMs: 100,
        timeoutMs: 10000,
      }),
    );

    // First attempt
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.attemptCount).toBe(1);

    // Second attempt
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.attemptCount).toBe(2);

    // Third attempt
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.attemptCount).toBe(3);
  });

  it("should clear timers on unmount", async () => {
    const checkHealthFn = vi.fn().mockResolvedValue(false);
    const { unmount } = renderHook(() =>
      useBackendConnectivity({
        checkHealthFn,
        initialDelayMs: 1000,
        timeoutMs: 60000,
      }),
    );

    // First attempt
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(checkHealthFn).toHaveBeenCalledTimes(1);

    // Unmount before next retry
    unmount();

    // Advance time - should not trigger more health checks
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(checkHealthFn).toHaveBeenCalledTimes(1);
  });

  it("should not update state after unmount during pending request", async () => {
    let resolveHealth: (value: boolean) => void;
    const checkHealthFn = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveHealth = resolve;
        }),
    );

    const { result, unmount } = renderHook(() =>
      useBackendConnectivity({ checkHealthFn }),
    );

    // Start the health check
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(checkHealthFn).toHaveBeenCalledTimes(1);

    // Unmount while request is pending
    unmount();

    // Resolve the pending request - should not cause state update
    await act(async () => {
      resolveHealth?.(true);
    });

    // No error should be thrown (React warning about updating unmounted component)
    expect(result.current.status).toBe("connecting");
  });

  it("should reset state on retry", async () => {
    let shouldSucceed = false;
    const checkHealthFn = vi.fn().mockImplementation(() => {
      return Promise.resolve(shouldSucceed);
    });

    const { result } = renderHook(() =>
      useBackendConnectivity({
        checkHealthFn,
        initialDelayMs: 100,
        timeoutMs: 10000,
      }),
    );

    // First and second attempts fail
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.attemptCount).toBe(2);

    // Now set health check to succeed on next call
    shouldSucceed = true;

    // Manual retry - state should reset
    await act(async () => {
      result.current.retry();
    });

    // State resets immediately before the health check completes
    expect(result.current.attemptCount).toBe(0);

    // Let the retry health check complete
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.status).toBe("connected");
  });
});
