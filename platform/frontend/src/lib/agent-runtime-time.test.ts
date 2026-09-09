import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useRuntimeClock } from "./agent-runtime-time";

afterEach(() => vi.useRealTimers());

test("refreshes retention immediately when a backgrounded tab becomes visible", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const { result } = renderHook(() => useRuntimeClock(true));
  const initial = result.current;
  vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
  expect(result.current).toBe(initial);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(result.current).toBe(Date.now());
});
