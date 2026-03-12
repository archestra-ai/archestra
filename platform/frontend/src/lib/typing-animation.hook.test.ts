import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTypingAnimation } from "./typing-animation.hook";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useTypingAnimation", () => {
  it("returns empty text for null input", () => {
    const { result } = renderHook(() => useTypingAnimation(null));
    expect(result.current.text).toBe("");
    expect(result.current.isAnimating).toBe(false);
  });

  it("returns empty text for undefined input", () => {
    const { result } = renderHook(() => useTypingAnimation(undefined));
    expect(result.current.text).toBe("");
    expect(result.current.isAnimating).toBe(false);
  });

  it("returns empty text for empty array", () => {
    const { result } = renderHook(() => useTypingAnimation([]));
    expect(result.current.text).toBe("");
    expect(result.current.isAnimating).toBe(false);
  });

  it("types out a single string character by character", () => {
    const texts = ["Hi"];
    const { result } = renderHook(() => useTypingAnimation(texts));

    // After first 50ms tick: "H"
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.text).toBe("H");
    expect(result.current.isAnimating).toBe(true);

    // After second 50ms tick: "Hi"
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.text).toBe("Hi");
  });

  it("pauses after typing completes then starts deleting", () => {
    const texts = ["Ab"];
    const { result } = renderHook(() => useTypingAnimation(texts));

    // Type full text "Ab" (2 ticks × 50ms)
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.text).toBe("Ab");

    // Still "Ab" during pause (5s)
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(result.current.text).toBe("Ab");

    // After 5s pause, trigger delete phase
    act(() => {
      vi.advanceTimersByTime(2500);
    });

    // Delete one char (30ms tick)
    act(() => {
      vi.advanceTimersByTime(30);
    });
    expect(result.current.text).toBe("A");
  });

  it("cleans up timers on unmount", () => {
    const texts = ["Hello"];
    const { unmount } = renderHook(() => useTypingAnimation(texts));

    act(() => {
      vi.advanceTimersByTime(50);
    });

    unmount();

    // No errors should occur after unmount
    act(() => {
      vi.advanceTimersByTime(10000);
    });
  });
});
