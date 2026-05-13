import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLatestAsyncGuard } from "./use-latest-async-guard";

describe("useLatestAsyncGuard", () => {
  it("marks earlier tokens as stale after a newer operation starts", () => {
    const { result } = renderHook(() => useLatestAsyncGuard());

    const firstToken = result.current.start();
    const secondToken = result.current.start();

    expect(result.current.isCurrent(firstToken)).toBe(false);
    expect(result.current.isCurrent(secondToken)).toBe(true);
  });

  it("keeps the latest token current", () => {
    const { result } = renderHook(() => useLatestAsyncGuard());

    const token = result.current.start();

    expect(result.current.isCurrent(token)).toBe(true);
  });

  it("invalidates the current token", () => {
    const { result } = renderHook(() => useLatestAsyncGuard());

    const token = result.current.start();
    result.current.invalidate();

    expect(result.current.isCurrent(token)).toBe(false);
  });

  it("returns stable methods between rerenders", () => {
    const { result, rerender } = renderHook(() => useLatestAsyncGuard());
    const guard = result.current;

    rerender();

    expect(result.current).toBe(guard);
    expect(result.current.start).toBe(guard.start);
    expect(result.current.isCurrent).toBe(guard.isCurrent);
    expect(result.current.invalidate).toBe(guard.invalidate);
  });
});
