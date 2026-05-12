import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDeferredEnabled } from "./use-deferred-enabled";

describe("useDeferredEnabled", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enables immediately when no delay is configured", () => {
    const { result } = renderHook(() => useDeferredEnabled(true, 0));

    expect(result.current).toBe(true);
  });

  it("defers enabling until the delay elapses", () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => useDeferredEnabled(true, 5000));

    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current).toBe(true);
  });

  it("stays disabled when disabled", () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => useDeferredEnabled(false, 5000));

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current).toBe(false);
  });
});
