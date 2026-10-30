import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStatisticsTimeRange } from "./statistics-time-range";

// Next returns the same search params object until the URL changes; a fresh
// one per render would re-run every effect that depends on it.
const navigation = vi.hoisted(() => ({
  params: new URLSearchParams(),
  push: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
  usePathname: () => "/llm/costs",
  useSearchParams: () => navigation.params,
}));

describe("useStatisticsTimeRange", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-13T12:00:10.000Z"));
    navigation.params = new URLSearchParams();
    navigation.push.mockReset();
    window.localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("keeps a range the API has no name for relative, and moves it with the clock", () => {
    const { result } = renderStatistics();

    act(() => result.current.setRange({ from: "now-6h", to: "now" }));

    expect(navigation.push).toHaveBeenCalledWith(
      "/llm/costs?timeframe=now-6h..now",
      { scroll: false },
    );
    expect(window.localStorage.getItem("costs")).toBe("now-6h..now");
    expect(result.current.timeframe).toBe(
      "custom:2026-10-13T06:00:00.000Z_2026-10-13T12:00:00.000Z",
    );

    act(() => {
      vi.setSystemTime(new Date("2026-10-13T12:05:10.000Z"));
      vi.advanceTimersByTime(15_000);
    });
    expect(result.current.timeframe).toBe(
      "custom:2026-10-13T06:05:00.000Z_2026-10-13T12:05:00.000Z",
    );
  });

  it("reads a relative range back from the URL", () => {
    navigation.params = new URLSearchParams("timeframe=now-6h..now");
    const { result } = renderStatistics();

    expect(result.current.isResolved).toBe(true);
    expect(result.current.range).toEqual({ from: "now-6h", to: "now" });
  });

  it("sends a range the API knows by its name", () => {
    const { result } = renderStatistics();

    act(() => result.current.setRange({ from: "now-7d", to: "now" }));

    expect(result.current.timeframe).toBe("7d");
    expect(navigation.push).toHaveBeenCalledWith("/llm/costs?timeframe=7d", {
      scroll: false,
    });
  });

  it("falls back to the default for a URL it cannot read", () => {
    navigation.params = new URLSearchParams("timeframe=garbage..now");
    const { result } = renderStatistics();

    expect(result.current.timeframe).toBe("24h");
  });
});

function renderStatistics() {
  return renderHook(() =>
    useStatisticsTimeRange({ storageKey: "costs", defaultTimeframe: "24h" }),
  );
}
