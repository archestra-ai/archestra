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

  it("keeps a single string static", () => {
    const texts = ["Hi"];
    const { result } = renderHook(() => useTypingAnimation(texts));

    expect(result.current.text).toBe("Hi");
    expect(result.current.isAnimating).toBe(false);
  });

  it("types out multi-string placeholders character by character", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const texts = ["Hi", "There"];
    const { result } = renderHook(() => useTypingAnimation(texts));

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.text).toBe("H");
    expect(result.current.isAnimating).toBe(true);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.text).toBe("Hi");
  });

  it("does not reset when rerendered with the same text values", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { result, rerender } = renderHook(
      ({ texts }) => useTypingAnimation(texts),
      {
        initialProps: { texts: ["Hi", "There"] },
      },
    );

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.text).toBe("H");

    rerender({ texts: ["Hi", "There"] });

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.text).toBe("Hi");
  });

  it("pauses after typing completes then starts deleting for multi-string placeholders", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const texts = ["Ab", "Cd"];
    const { result } = renderHook(() => useTypingAnimation(texts));

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.text).toBe("Ab");

    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(result.current.text).toBe("Ab");

    act(() => {
      vi.advanceTimersByTime(2500);
    });

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
