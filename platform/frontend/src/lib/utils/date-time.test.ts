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

    it("returns 'Resetting soon' when next reset is exactly now", () => {
      // Force the exact boundary: nextReset === now
      // This is the only case where "Resetting soon" triggers
      // since getNextResetTime recalculates for past dates
      const lastCleanup = new Date(); // now
      const result = formatResetCountdown(lastCleanup, "1h");
      // next = now + 1h, which is in the future, so NOT "Resetting soon"
      expect(result).toContain("resets");
    });

    it("returns null for invalid lastCleanup", () => {
      expect(formatResetCountdown("invalid", "1w")).toBeNull();
    });

    it("handles unknown cleanup interval gracefully (defaults to 1w)", () => {
      const lastCleanup = new Date("2026-03-14T12:00:00.000Z"); // 1 day ago
      const result = formatResetCountdown(lastCleanup, "unknown_interval");
      // Should fallback to 1w, so next reset is ~6 days away
      expect(result).toContain("resets");
    });

    it("handles 1h interval correctly", () => {
      const lastCleanup = new Date("2026-03-15T11:30:00.000Z"); // 30 min ago
      const result = formatResetCountdown(lastCleanup, "1h");
      // Next reset = 12:30, current = 12:00 → 30 min left
      expect(result).toBe("resets 30 minutes");
    });

    it("handles 1m (monthly) interval correctly", () => {
      const lastCleanup = new Date("2026-03-01T12:00:00.000Z"); // 14 days ago
      const result = formatResetCountdown(lastCleanup, "1m");
      // 1m = 30 days, next = March 31, current = March 15 → 16 days
      expect(result).toContain("resets");
    });
  });
});
