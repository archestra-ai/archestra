import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatPlaceholder } from "./chat-placeholder.hook";

const { mockUseTypingAnimation } = vi.hoisted(() => ({
  mockUseTypingAnimation: vi.fn(),
}));

vi.mock("./typing-animation.hook", () => ({
  useTypingAnimation: (...args: unknown[]) => mockUseTypingAnimation(...args),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("useChatPlaceholder", () => {
  it("returns null when no placeholders are provided", () => {
    mockUseTypingAnimation.mockReturnValue({ text: "", isAnimating: false });

    const { result } = renderHook(() =>
      useChatPlaceholder({ animate: false, placeholders: null }),
    );

    expect(result.current.placeholder).toBeNull();
    expect(result.current.isAnimating).toBe(false);
  });

  it("returns the only placeholder as static text", () => {
    mockUseTypingAnimation.mockReturnValue({ text: "", isAnimating: false });

    const { result } = renderHook(() =>
      useChatPlaceholder({
        animate: true,
        placeholders: ["Ask support"],
      }),
    );

    expect(result.current.placeholder).toBe("Ask support");
    expect(result.current.isAnimating).toBe(false);
  });

  it("picks a random static placeholder when animation is disabled", () => {
    mockUseTypingAnimation.mockReturnValue({ text: "", isAnimating: false });
    vi.spyOn(Math, "random").mockReturnValue(0.7);

    const { result } = renderHook(() =>
      useChatPlaceholder({
        animate: false,
        placeholders: ["First", "Second", "Third"],
      }),
    );

    expect(result.current.placeholder).toBe("Third");
    expect(result.current.isAnimating).toBe(false);
    expect(mockUseTypingAnimation).toHaveBeenCalledWith(null);
  });

  it("keeps the same static placeholder on rerender when inputs are unchanged", () => {
    mockUseTypingAnimation.mockReturnValue({ text: "", isAnimating: false });
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.8);

    const { result, rerender } = renderHook(
      ({ placeholders }) =>
        useChatPlaceholder({
          animate: false,
          placeholders,
        }),
      {
        initialProps: { placeholders: ["First", "Second"] },
      },
    );

    expect(result.current.placeholder).toBe("Second");

    rerender({ placeholders: ["First", "Second"] });

    expect(result.current.placeholder).toBe("Second");
    expect(randomSpy).toHaveBeenCalledTimes(1);
  });

  it("re-picks a static placeholder when placeholders change", () => {
    mockUseTypingAnimation.mockReturnValue({ text: "", isAnimating: false });
    const randomSpy = vi
      .spyOn(Math, "random")
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.8);

    const { result, rerender } = renderHook(
      ({ placeholders }) =>
        useChatPlaceholder({
          animate: false,
          placeholders,
        }),
      {
        initialProps: { placeholders: ["First", "Second"] },
      },
    );

    expect(result.current.placeholder).toBe("First");

    rerender({ placeholders: ["Alpha", "Beta"] });

    expect(result.current.placeholder).toBe("Beta");
    expect(randomSpy).toHaveBeenCalledTimes(2);
  });

  it("re-picks a static placeholder when animation is turned off", () => {
    mockUseTypingAnimation.mockReturnValue({
      text: "Animated placeholder",
      isAnimating: true,
    });
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.6);

    const { result, rerender } = renderHook(
      ({ animate }) =>
        useChatPlaceholder({
          animate,
          placeholders: ["First", "Second", "Third"],
        }),
      {
        initialProps: { animate: true },
      },
    );

    expect(result.current.placeholder).toBe("Animated placeholder");
    expect(result.current.isAnimating).toBe(true);

    rerender({ animate: false });

    expect(result.current.placeholder).toBe("Second");
    expect(result.current.isAnimating).toBe(false);
    expect(randomSpy).toHaveBeenCalledTimes(1);
  });

  it("uses typing animation when animation is enabled", () => {
    mockUseTypingAnimation.mockReturnValue({
      text: "Animated placeholder",
      isAnimating: true,
    });

    const { result } = renderHook(() =>
      useChatPlaceholder({
        animate: true,
        placeholders: ["First", "Second"],
      }),
    );

    expect(result.current.placeholder).toBe("Animated placeholder");
    expect(result.current.isAnimating).toBe(true);
    expect(mockUseTypingAnimation).toHaveBeenCalledWith(["First", "Second"]);
  });
});
