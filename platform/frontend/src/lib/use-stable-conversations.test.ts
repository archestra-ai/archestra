import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useStableConversations } from "./use-stable-conversations";

type Item = { id: string };

function ids(items: Item[]) {
  return items.map((i) => i.id);
}

describe("useStableConversations", () => {
  it("returns the original order on first render", () => {
    const items: Item[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const { result } = renderHook(() => useStableConversations(items));

    expect(ids(result.current)).toEqual(["a", "b", "c"]);
  });

  it("preserves the original order when items are re-ordered on re-render", () => {
    const initial: Item[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const { result, rerender } = renderHook(
      ({ items }) => useStableConversations(items),
      { initialProps: { items: initial } },
    );

    expect(ids(result.current)).toEqual(["a", "b", "c"]);

    // Simulate updatedAt bump moving "c" to the front
    const reordered: Item[] = [{ id: "c" }, { id: "a" }, { id: "b" }];
    rerender({ items: reordered });

    // Order should remain frozen
    expect(ids(result.current)).toEqual(["a", "b", "c"]);
  });

  it("prepends new conversations at the top", () => {
    const initial: Item[] = [{ id: "a" }, { id: "b" }];
    const { result, rerender } = renderHook(
      ({ items }) => useStableConversations(items),
      { initialProps: { items: initial } },
    );

    expect(ids(result.current)).toEqual(["a", "b"]);

    // New conversation "x" appears
    const withNew: Item[] = [{ id: "x" }, { id: "a" }, { id: "b" }];
    rerender({ items: withNew });

    expect(ids(result.current)).toEqual(["x", "a", "b"]);
  });

  it("removes deleted conversations", () => {
    const initial: Item[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const { result, rerender } = renderHook(
      ({ items }) => useStableConversations(items),
      { initialProps: { items: initial } },
    );

    expect(ids(result.current)).toEqual(["a", "b", "c"]);

    // "b" is deleted
    const afterDelete: Item[] = [{ id: "a" }, { id: "c" }];
    rerender({ items: afterDelete });

    expect(ids(result.current)).toEqual(["a", "c"]);
  });

  it("handles simultaneous add and delete", () => {
    const initial: Item[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const { result, rerender } = renderHook(
      ({ items }) => useStableConversations(items),
      { initialProps: { items: initial } },
    );

    // "b" deleted, "x" added
    const updated: Item[] = [{ id: "x" }, { id: "a" }, { id: "c" }];
    rerender({ items: updated });

    expect(ids(result.current)).toEqual(["x", "a", "c"]);
  });

  it("resets order when conversations become empty then repopulate", () => {
    const initial: Item[] = [{ id: "a" }, { id: "b" }];
    const { result, rerender } = renderHook(
      ({ items }) => useStableConversations(items),
      { initialProps: { items: initial } },
    );

    expect(ids(result.current)).toEqual(["a", "b"]);

    // All conversations cleared
    rerender({ items: [] });
    expect(ids(result.current)).toEqual([]);

    // Repopulate in different order — should adopt new order as baseline
    const repopulated: Item[] = [{ id: "b" }, { id: "a" }];
    rerender({ items: repopulated });

    expect(ids(result.current)).toEqual(["b", "a"]);
  });

  it("returns empty array for empty input", () => {
    const { result } = renderHook(() => useStableConversations([]));
    expect(result.current).toEqual([]);
  });

  it("preserves item data (not just IDs)", () => {
    type Rich = { id: string; title: string };
    const initial: Rich[] = [
      { id: "a", title: "Alpha" },
      { id: "b", title: "Beta" },
    ];
    const { result, rerender } = renderHook(
      ({ items }) => useStableConversations(items),
      { initialProps: { items: initial } },
    );

    // Re-render with updated data but reordered
    const updated: Rich[] = [
      { id: "b", title: "Beta Updated" },
      { id: "a", title: "Alpha Updated" },
    ];
    rerender({ items: updated });

    // Order stable, but data is fresh
    expect(result.current).toEqual([
      { id: "a", title: "Alpha Updated" },
      { id: "b", title: "Beta Updated" },
    ]);
  });

  it("handles multiple new conversations added at once", () => {
    const initial: Item[] = [{ id: "a" }];
    const { result, rerender } = renderHook(
      ({ items }) => useStableConversations(items),
      { initialProps: { items: initial } },
    );

    const withMultipleNew: Item[] = [{ id: "x" }, { id: "y" }, { id: "a" }];
    rerender({ items: withMultipleNew });

    // New items prepended in their original relative order
    expect(ids(result.current)).toEqual(["x", "y", "a"]);
  });

  it("is stable across multiple re-renders with same reordered data", () => {
    const initial: Item[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const { result, rerender } = renderHook(
      ({ items }) => useStableConversations(items),
      { initialProps: { items: initial } },
    );

    const reordered: Item[] = [{ id: "c" }, { id: "b" }, { id: "a" }];

    // Multiple re-renders with reordered data
    rerender({ items: reordered });
    expect(ids(result.current)).toEqual(["a", "b", "c"]);

    rerender({ items: reordered });
    expect(ids(result.current)).toEqual(["a", "b", "c"]);

    rerender({ items: reordered });
    expect(ids(result.current)).toEqual(["a", "b", "c"]);
  });
});
