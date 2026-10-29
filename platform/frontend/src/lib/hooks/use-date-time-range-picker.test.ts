import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDateTimeRangePicker } from "./use-date-time-range-picker";

describe("useDateTimeRangePicker", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T12:00:30.000Z"));
    window.localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("ignores a URL whose dates it cannot read, instead of throwing", () => {
    const { result } = renderHook(() =>
      useDateTimeRangePicker({
        startDateFromUrl: "not-a-date",
        endDateFromUrl: "2026-09-25T10:00:00.000Z",
        onDateRangeChange: () => {},
      }),
    );

    expect(result.current.range).toBeNull();
    expect(result.current.startDateParam).toBeUndefined();
    expect(result.current.endDateParam).toBeUndefined();
  });

  it("keeps the range across log pages, unless the URL names its own", () => {
    const first = renderHook(() =>
      useDateTimeRangePicker({
        startDateFromUrl: null,
        endDateFromUrl: null,
        onDateRangeChange: () => {},
      }),
    );
    act(() => first.result.current.setRange({ from: "now-6h", to: "now" }));
    first.unmount();

    const nextTab = renderHook(() =>
      useDateTimeRangePicker({
        startDateFromUrl: null,
        endDateFromUrl: null,
        onDateRangeChange: () => {},
      }),
    );
    expect(nextTab.result.current.range).toEqual({
      from: "now-6h",
      to: "now",
    });

    const sharedLink = renderHook(() =>
      useDateTimeRangePicker({
        startDateFromUrl: "now-1h",
        endDateFromUrl: "now",
        onDateRangeChange: () => {},
      }),
    );
    expect(sharedLink.result.current.range).toEqual({
      from: "now-1h",
      to: "now",
    });

    act(() => nextTab.result.current.clearDateRange());
    const afterClear = renderHook(() =>
      useDateTimeRangePicker({
        startDateFromUrl: null,
        endDateFromUrl: null,
        onDateRangeChange: () => {},
      }),
    );
    expect(afterClear.result.current.range).toBeNull();
  });

  it("still reads exact dates from older links", () => {
    const { result } = renderHook(() =>
      useDateTimeRangePicker({
        startDateFromUrl: "2026-09-25T08:00:00.000Z",
        endDateFromUrl: "2026-09-25T10:00:00.000Z",
        onDateRangeChange: () => {},
      }),
    );

    expect(result.current.startDateParam).toBe("2026-09-25T08:00:00.000Z");
    expect(result.current.endDateParam).toBe("2026-09-25T10:00:00.000Z");
  });

  it("keeps a relative range relative in the URL and leaves its end open", () => {
    const onDateRangeChange = vi.fn();
    const { result } = renderHook(() =>
      useDateTimeRangePicker({
        startDateFromUrl: null,
        endDateFromUrl: null,
        onDateRangeChange,
      }),
    );

    act(() => result.current.setRange({ from: "now-6h", to: "now" }));

    expect(onDateRangeChange).toHaveBeenCalledWith({
      startDate: "now-6h",
      endDate: "now",
    });
    // Resolved to the start of the minute, so queries keep a stable key.
    expect(result.current.startDateParam).toBe("2026-10-13T06:00:00.000Z");
    expect(result.current.endDateParam).toBeUndefined();
    expect(result.current.getDateRangeDisplay()).toBe("Last 6 hours");
  });
});
