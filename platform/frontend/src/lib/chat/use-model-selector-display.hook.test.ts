import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useModelSelectorDisplay } from "./use-model-selector-display.hook";

describe("useModelSelectorDisplay", () => {
  it("should start collapsed by default", () => {
    const { result } = renderHook(() => useModelSelectorDisplay());

    expect(result.current.isCollapsed).toBe(true);
  });

  it("should start collapsed when conversationId is provided", () => {
    const { result } = renderHook(() =>
      useModelSelectorDisplay({ conversationId: "conv-1" }),
    );

    expect(result.current.isCollapsed).toBe(true);
  });

  it("should expand when expand() is called", () => {
    const { result } = renderHook(() => useModelSelectorDisplay());

    act(() => {
      result.current.expand();
    });

    expect(result.current.isCollapsed).toBe(false);
  });

  it("should reset to collapsed when conversationId changes", () => {
    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId?: string }) =>
        useModelSelectorDisplay({ conversationId }),
      { initialProps: { conversationId: "conv-1" } },
    );

    // Expand
    act(() => {
      result.current.expand();
    });
    expect(result.current.isCollapsed).toBe(false);

    // Change conversation
    rerender({ conversationId: "conv-2" });

    expect(result.current.isCollapsed).toBe(true);
  });

  it("should reset to collapsed when navigating from conversation to new chat", () => {
    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string | undefined }) =>
        useModelSelectorDisplay({ conversationId }),
      { initialProps: { conversationId: "conv-1" as string | undefined } },
    );

    // Expand
    act(() => {
      result.current.expand();
    });
    expect(result.current.isCollapsed).toBe(false);

    // Navigate to new chat (no conversationId)
    rerender({ conversationId: undefined });

    expect(result.current.isCollapsed).toBe(true);
  });

  it("should reset to collapsed when navigating from new chat to conversation", () => {
    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string | undefined }) =>
        useModelSelectorDisplay({ conversationId }),
      { initialProps: { conversationId: undefined as string | undefined } },
    );

    // Expand
    act(() => {
      result.current.expand();
    });
    expect(result.current.isCollapsed).toBe(false);

    // Navigate to a conversation
    rerender({ conversationId: "conv-1" });

    expect(result.current.isCollapsed).toBe(true);
  });

  it("should stay collapsed if conversationId does not change", () => {
    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId?: string }) =>
        useModelSelectorDisplay({ conversationId }),
      { initialProps: { conversationId: "conv-1" } },
    );

    expect(result.current.isCollapsed).toBe(true);

    // Rerender with same conversationId
    rerender({ conversationId: "conv-1" });

    expect(result.current.isCollapsed).toBe(true);
  });

  it("should maintain expanded state across rerenders with same conversationId", () => {
    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId?: string }) =>
        useModelSelectorDisplay({ conversationId }),
      { initialProps: { conversationId: "conv-1" } },
    );

    act(() => {
      result.current.expand();
    });
    expect(result.current.isCollapsed).toBe(false);

    // Rerender with same conversationId
    rerender({ conversationId: "conv-1" });

    expect(result.current.isCollapsed).toBe(false);
  });

  it("should return a stable expand function reference", () => {
    const { result, rerender } = renderHook(() => useModelSelectorDisplay());

    const firstExpand = result.current.expand;
    rerender();
    const secondExpand = result.current.expand;

    expect(firstExpand).toBe(secondExpand);
  });
});
