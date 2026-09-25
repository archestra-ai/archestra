import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDateTimeRangePicker } from "./use-date-time-range-picker";

describe("useDateTimeRangePicker", () => {
  it("ignores unparseable URL dates instead of throwing", () => {
    const { result } = renderHook(() =>
      useDateTimeRangePicker({
        startDateFromUrl: "not-a-date",
        endDateFromUrl: "2026-09-25T10:00:00.000Z",
        onDateRangeChange: () => {},
      }),
    );

    expect(result.current.startDateParam).toBeUndefined();
    expect(result.current.endDateParam).toBe("2026-09-25T10:00:00.000Z");
  });
});
