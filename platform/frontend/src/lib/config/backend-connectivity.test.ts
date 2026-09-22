import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateEstimatedTotalAttempts,
  useBackendConnectivity,
} from "./backend-connectivity";

describe("useBackendConnectivity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should start in initializing state when autoStart is false", () => {
    const checkReadinessFn = vi.fn().mockResolvedValue("backend-unreachable");
    const { result } = renderHook(() =>
      useBackendConnectivity({ checkReadinessFn, autoStart: false }),
    );

    expect(result.current.status).toBe("initializing");
    expect(result.current.attemptCount).toBe(0);
    expect(result.current.elapsedMs).toBe(0);
    expect(result.current.nextRetryInMs).toBeNull();
  });

  it("should start in checking state when autoStart is true", () => {
    const checkReadinessFn = vi.fn().mockResolvedValue("ready");
    const { result } = renderHook(() =>
      useBackendConnectivity({ checkReadinessFn }),
    );

    // Before the health check completes, should be in "checking" state
    expect(result.current.status).toBe("checking");
  });

  it("should transition directly to connected on successful first attempt without showing connecting UI", async () => {
    const checkReadinessFn = vi.fn().mockResolvedValue("ready");
    const { result } = renderHook(() =>
      useBackendConnectivity({ checkReadinessFn }),
    );

    // Start in "checking" state (no UI shown)
    expect(result.current.status).toBe("checking");

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Should go directly to "connected" without ever showing "connecting"
    expect(result.current.status).toBe("connected");
    expect(checkReadinessFn).toHaveBeenCalledTimes(1);
  });

  it("should transition to connected on successful first attempt", async () => {
    const checkReadinessFn = vi.fn().mockResolvedValue("ready");
    const { result } = renderHook(() =>
      useBackendConnectivity({ checkReadinessFn }),
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.status).toBe("connected");
    expect(checkReadinessFn).toHaveBeenCalledTimes(1);
  });

  it("keeps database failures distinct during retries and after the timeout", async () => {
    const checkReadinessFn = vi.fn().mockResolvedValue("database-unavailable");
    const { result } = renderHook(() =>
      useBackendConnectivity({
        checkReadinessFn,
        timeoutMs: 1000,
        initialDelayMs: 1000,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("database-connecting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.status).toBe("database-unavailable");
  });

  it("returns to sign-in when database readiness recovers", async () => {
    const checkReadinessFn = vi
      .fn()
      .mockResolvedValueOnce("database-unavailable")
      .mockResolvedValue("ready");
    const { result } = renderHook(() =>
      useBackendConnectivity({ checkReadinessFn, initialDelayMs: 1000 }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("database-connecting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.status).toBe("connected");
  });

  it("keeps browser offline distinct from a server failure", async () => {
    const checkReadinessFn = vi.fn().mockResolvedValue("browser-offline");
    const { result } = renderHook(() =>
      useBackendConnectivity({ checkReadinessFn, timeoutMs: 1000 }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("browser-connecting");
  });

  it("should retry with exponential backoff on failure", async () => {
    let callCount = 0;
    const checkReadinessFn = vi.fn().mockImplementation(() => {
      callCount++;
      // Succeed on the 3rd attempt
      return Promise.resolve(callCount >= 3 ? "ready" : "backend-unreachable");
    });

    const { result } = renderHook(() =>
      useBackendConnectivity({
        checkReadinessFn,
        initialDelayMs: 1000,
        maxDelayMs: 30000,
      }),
    );

    // First attempt happens immediately, starts in "checking" state
    expect(result.current.status).toBe("checking");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(checkReadinessFn).toHaveBeenCalledTimes(1);
    expect(result.current.attemptCount).toBe(1);
    expect(result.current.nextRetryInMs).toBe(1000);
    // After first failure, transitions to "connecting"
    expect(result.current.status).toBe("connecting");

    // Wait for first retry (1s delay after first failure)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(checkReadinessFn).toHaveBeenCalledTimes(2);
    expect(result.current.attemptCount).toBe(2);
    expect(result.current.nextRetryInMs).toBe(2000);

    // Wait for second retry (2s delay after second failure)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(checkReadinessFn).toHaveBeenCalledTimes(3);
    expect(result.current.status).toBe("connected");
    expect(result.current.nextRetryInMs).toBeNull();
  });

  it("should respect maxDelayMs for exponential backoff", async () => {
    const checkReadinessFn = vi.fn().mockResolvedValue("backend-unreachable");
    const { result } = renderHook(() =>
      useBackendConnectivity({
        checkReadinessFn,
        initialDelayMs: 1000,
        maxDelayMs: 4000,
        timeoutMs: 100000,
      }),
    );

    // First attempt
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(checkReadinessFn).toHaveBeenCalledTimes(1);

    // 1s delay (1000 * 2^0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(checkReadinessFn).toHaveBeenCalledTimes(2);

    // 2s delay (1000 * 2^1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(checkReadinessFn).toHaveBeenCalledTimes(3);

    // 4s delay (1000 * 2^2 = 4000, capped at maxDelayMs)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(checkReadinessFn).toHaveBeenCalledTimes(4);

    // Next delay should still be 4s (capped at maxDelayMs)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(checkReadinessFn).toHaveBeenCalledTimes(5);

    expect(result.current.status).toBe("connecting");
  });

  it("should transition to unreachable after timeout", async () => {
    const checkReadinessFn = vi.fn().mockResolvedValue("backend-unreachable");
    const { result } = renderHook(() =>
      useBackendConnectivity({
        checkReadinessFn,
        timeoutMs: 3000,
        initialDelayMs: 500,
        maxDelayMs: 1000,
      }),
    );

    // Starts in "checking" state
    expect(result.current.status).toBe("checking");

    // First attempt (immediate) - transitions to "connecting" after failure
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
    let resolveReadiness:
      | ((value: "ready" | "backend-unreachable") => void)
      | null = null;
    const checkReadinessFn = vi.fn().mockImplementation(() => {
      return new Promise<"ready" | "backend-unreachable">((resolve) => {
        resolveReadiness = resolve;
      });
    });

    const { result } = renderHook(() =>
      useBackendConnectivity({
        checkReadinessFn,
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
      resolveReadiness?.("backend-unreachable");
    });

    // Attempt 2
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await act(async () => {
      resolveReadiness?.("backend-unreachable");
    });

    // Attempt 3
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await act(async () => {
      resolveReadiness?.("backend-unreachable");
    });

    // Attempt 4 - should trigger unreachable since elapsed >= 1500ms
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await act(async () => {
      resolveReadiness?.("backend-unreachable");
    });

    expect(result.current.status).toBe("unreachable");

    // Manually retry - this resets state to "checking"
    act(() => {
      result.current.retry();
    });

    // The retry call itself sets status to "checking" synchronously
    // before the async health check starts
    expect(result.current.status).toBe("checking");
    expect(result.current.attemptCount).toBe(0);

    // Now resolve the health check with success
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      resolveReadiness?.("ready");
    });

    expect(result.current.status).toBe("connected");
  });

  it("should not start automatically when autoStart is false", async () => {
    const checkReadinessFn = vi.fn().mockResolvedValue("ready");
    const { result } = renderHook(() =>
      useBackendConnectivity({ checkReadinessFn, autoStart: false }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(checkReadinessFn).not.toHaveBeenCalled();
    expect(result.current.status).toBe("initializing");
  });

  it("should start when retry is called with autoStart false", async () => {
    let resolveReadiness: (value: "ready" | "backend-unreachable") => void;
    const checkReadinessFn = vi.fn().mockImplementation(
      () =>
        new Promise<"ready" | "backend-unreachable">((resolve) => {
          resolveReadiness = resolve;
        }),
    );

    const { result } = renderHook(() =>
      useBackendConnectivity({ checkReadinessFn, autoStart: false }),
    );

    // Starts in "initializing" since autoStart is false
    expect(result.current.status).toBe("initializing");

    // Call retry - this should start the health check
    act(() => {
      result.current.retry();
    });

    // After retry, transitions to "checking"
    expect(result.current.status).toBe("checking");

    // Now resolve the health check
    await act(async () => {
      resolveReadiness("ready");
    });

    expect(checkReadinessFn).toHaveBeenCalled();
    expect(result.current.status).toBe("connected");
  });

  it("should track elapsed time correctly", async () => {
    const checkReadinessFn = vi.fn().mockResolvedValue("backend-unreachable");
    const { result } = renderHook(() =>
      useBackendConnectivity({
        checkReadinessFn,
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
    const checkReadinessFn = vi.fn().mockResolvedValue("backend-unreachable");
    const { result } = renderHook(() =>
      useBackendConnectivity({
        checkReadinessFn,
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
    const checkReadinessFn = vi.fn().mockResolvedValue("backend-unreachable");
    const { unmount } = renderHook(() =>
      useBackendConnectivity({
        checkReadinessFn,
        initialDelayMs: 1000,
        timeoutMs: 60000,
      }),
    );

    // First attempt
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(checkReadinessFn).toHaveBeenCalledTimes(1);

    // Unmount before next retry
    unmount();

    // Advance time - should not trigger more health checks
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(checkReadinessFn).toHaveBeenCalledTimes(1);
  });

  it("should not update state after unmount during pending request", async () => {
    let resolveReadiness: (value: "ready" | "backend-unreachable") => void;
    const checkReadinessFn = vi.fn().mockImplementation(
      () =>
        new Promise<"ready" | "backend-unreachable">((resolve) => {
          resolveReadiness = resolve;
        }),
    );

    const { result, unmount } = renderHook(() =>
      useBackendConnectivity({ checkReadinessFn }),
    );

    // Should start in "checking" state
    expect(result.current.status).toBe("checking");

    // Start the health check
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(checkReadinessFn).toHaveBeenCalledTimes(1);

    // Unmount while request is pending
    unmount();

    // Resolve the pending request - should not cause state update
    await act(async () => {
      resolveReadiness?.("ready");
    });

    // No error should be thrown (React warning about updating unmounted component)
    // State remains "checking" since the request was pending when unmounted
    expect(result.current.status).toBe("checking");
  });

  it("should reset state on retry", async () => {
    let shouldSucceed = false;
    const checkReadinessFn = vi.fn().mockImplementation(() => {
      return Promise.resolve(shouldSucceed ? "ready" : "backend-unreachable");
    });

    const { result } = renderHook(() =>
      useBackendConnectivity({
        checkReadinessFn,
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

  it("should return estimatedTotalAttempts based on backoff schedule", () => {
    const checkReadinessFn = vi.fn().mockResolvedValue("backend-unreachable");
    const { result } = renderHook(() =>
      useBackendConnectivity({
        checkReadinessFn,
        timeoutMs: 60000,
        initialDelayMs: 1000,
        maxDelayMs: 30000,
        autoStart: false,
      }),
    );

    // With defaults (60s timeout, 1s initial, 30s max):
    // delays: 1s, 2s, 4s, 8s, 16s, 30s = 61s cumulative → 7 attempts total
    expect(result.current.estimatedTotalAttempts).toBe(7);
  });
});

describe("calculateEstimatedTotalAttempts", () => {
  it("should calculate correctly with default values", () => {
    // 60s timeout, 1s initial, 30s max
    // Delays: 1s(1), 2s(3), 4s(7), 8s(15), 16s(31), 30s(61) → 7 attempts
    expect(calculateEstimatedTotalAttempts(60000, 1000, 30000)).toBe(7);
  });

  it("should calculate correctly with small timeout", () => {
    // 3s timeout, 500ms initial, 1s max
    // Delays: 500ms(0.5), 1s(1.5), 1s(2.5), 1s(3.5) → 5 attempts
    expect(calculateEstimatedTotalAttempts(3000, 500, 1000)).toBe(5);
  });

  it("should handle case where single delay exceeds timeout", () => {
    // 500ms timeout, 1s initial, 30s max
    // Delays: 1s(1) → 2 attempts
    expect(calculateEstimatedTotalAttempts(500, 1000, 30000)).toBe(2);
  });
});
