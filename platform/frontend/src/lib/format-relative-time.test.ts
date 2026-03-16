import { addDays, subDays } from "date-fns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatRelativeTime,
  formatRelativeTimeFromNow,
} from "./format-relative-time";

describe("format-relative-time", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("formatRelativeTime", () => {
    it("returns the default never label for null values", () => {
      expect(formatRelativeTime(null)).toBe("Never");
    });

    it("returns the invalid label for invalid dates", () => {
      expect(
        formatRelativeTime("not-a-date", { invalidLabel: "Invalid date" }),
      ).toBe("Invalid date");
    });

    it("returns the past label for past dates", () => {
      expect(formatRelativeTime(subDays(new Date(), 1))).toBe("Expired");
    });

    it("returns a future relative time for future dates", () => {
      expect(formatRelativeTime(addDays(new Date(), 2))).toBe("in 2 days");
    });
  });

  describe("formatRelativeTimeFromNow", () => {
    it("returns the default never label for null values", () => {
      expect(formatRelativeTimeFromNow(null)).toBe("Never");
    });

    it("returns the invalid label for invalid dates", () => {
      expect(
        formatRelativeTimeFromNow("not-a-date", {
          invalidLabel: "Invalid date",
        }),
      ).toBe("Invalid date");
    });

    it("returns past relative time for past dates", () => {
      expect(formatRelativeTimeFromNow(subDays(new Date(), 5))).toBe(
        "5 days ago",
      );
    });

    it("returns future relative time for future dates", () => {
      expect(formatRelativeTimeFromNow(addDays(new Date(), 3))).toBe(
        "in 3 days",
      );
    });
  });
});
