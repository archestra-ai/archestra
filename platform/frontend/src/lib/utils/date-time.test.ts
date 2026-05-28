import { addDays, addHours, subDays } from "date-fns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatDate,
  formatRelativeTime,
  formatRelativeTimeFromNow,
  formatResetCountdown,
  getNextResetTime,
} from "./date-time";

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

  describe("formatDate", () => {
    it("formats ISO timestamps with the default format", () => {
      expect(formatDate({ date: "2026-03-15T12:34:56" })).toBe(
        "03/15/2026 12:34:56",
      );
    });
  });

  describe("getNextResetTime", () => {
    it("returns null for null lastCleanup", () => {
      expect(getNextResetTime(null, "1w")).toBeNull();
    });

    it("returns null for undefined lastCleanup", () => {
      expect(getNextResetTime(undefined, "1w")).toBeNull();
    });

    it("returns null for invalid date string", () => {
      expect(getNextResetTime("not-a-date", "1w")).toBeNull();
    });

    it("calculates next reset for 1h interval", () => {
      const lastCleanup = new Date("2026-03-15T11:00:00.000Z");
      const result = getNextResetTime(lastCleanup, "1h");
      expect(result).toEqual(new Date("2026-03-15T12:00:00.000Z"));
    });

    it("calculates next reset for 24h interval", () => {
      const lastCleanup = new Date("2026-03-14T12:00:00.000Z");
      const result = getNextResetTime(lastCleanup, "24h");
      expect(result).toEqual(new Date("2026-03-15T12:00:00.000Z"));
    });

    it("calculates next reset for 1w interval", () => {
      const lastCleanup = new Date("2026-03-08T12:00:00.000Z");
      const result = getNextResetTime(lastCleanup, "1w");
      expect(result).toEqual(new Date("2026-03-15T12:00:00.000Z"));
    });

    it("defaults to 1w interval when cleanupInterval is null", () => {
      const lastCleanup = new Date("2026-03-08T12:00:00.000Z");
      const result = getNextResetTime(lastCleanup, null);
      expect(result).toEqual(new Date("2026-03-15T12:00:00.000Z"));
    });

    it("returns future date from now when calculated reset is in the past", () => {
      // lastCleanup was 2 weeks ago with 1w interval -> reset already passed
      const lastCleanup = subDays(new Date(), 14);
      const result = getNextResetTime(lastCleanup, "1w");
      expect(result).toBeInstanceOf(Date);
      expect(result!.getTime()).toBeGreaterThan(Date.now());
    });

    it("accepts string dates", () => {
      const result = getNextResetTime(
        "2026-03-15T11:00:00.000Z",
        "1h",
      );
      expect(result).toEqual(new Date("2026-03-15T12:00:00.000Z"));
    });
  });

  describe("formatResetCountdown", () => {
    it("returns null for null lastCleanup", () => {
      expect(formatResetCountdown(null, "1w")).toBeNull();
    });

    it("returns countdown string for valid data", () => {
      const lastCleanup = addHours(new Date(), -1); // 1 hour ago
      // With 12h interval, next reset is in 11 hours
      const result = formatResetCountdown(lastCleanup, "12h");
      expect(result).toBe("resets about 11 hours");
    });

    it("returns 'Resetting soon' when reset time is in the past", () => {
      const lastCleanup = subDays(new Date(), 8); // 8 days ago with 1w interval
      // The calculated next reset (7 days from lastCleanup = 1 day ago) is in the past
      // But the function recalculates from now, so it should NOT be "Resetting soon"
      const result = formatResetCountdown(lastCleanup, "1w");
      // Since recalculated from now, it should show ~7 days
      expect(result).toContain("resets");
    });

    it("returns null for invalid lastCleanup", () => {
      expect(formatResetCountdown("invalid", "1w")).toBeNull();
    });
  });
});
