import { addDays, subDays } from "date-fns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatDate,
  formatLocalDateTime,
  formatRelativeTime,
  formatRelativeTimeFromNow,
  getNextCleanupTime,
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

  describe("getNextCleanupTime", () => {
    it("returns null for null lastCleanup", () => {
      expect(getNextCleanupTime(null, "1h")).toBeNull();
    });

    it("returns null for null cleanupInterval", () => {
      expect(getNextCleanupTime("2026-03-15T12:00:00Z", null)).toBeNull();
    });

    it("returns null for undefined cleanupInterval", () => {
      expect(getNextCleanupTime("2026-03-15T12:00:00Z", undefined)).toBeNull();
    });

    it("returns null for invalid lastCleanup date", () => {
      expect(getNextCleanupTime("not-a-date", "1h")).toBeNull();
    });

    it("adds 1 hour for 1h interval", () => {
      const result = getNextCleanupTime("2026-03-15T12:00:00Z", "1h");
      expect(result).toEqual(new Date("2026-03-15T13:00:00Z"));
    });

    it("adds 12 hours for 12h interval", () => {
      const result = getNextCleanupTime("2026-03-15T12:00:00Z", "12h");
      expect(result).toEqual(new Date("2026-03-16T00:00:00Z"));
    });

    it("adds 24 hours for 24h interval", () => {
      const result = getNextCleanupTime("2026-03-15T12:00:00Z", "24h");
      expect(result).toEqual(new Date("2026-03-16T12:00:00Z"));
    });

    it("adds 1 week for 1w interval", () => {
      const result = getNextCleanupTime("2026-03-15T12:00:00Z", "1w");
      expect(result).toEqual(new Date("2026-03-22T12:00:00Z"));
    });

    it("adds 1 month for 1m interval", () => {
      const result = getNextCleanupTime("2026-03-15T12:00:00Z", "1m");
      expect(result).toEqual(new Date("2026-04-15T12:00:00Z"));
    });
  });

  describe("formatLocalDateTime", () => {
    it("returns null for null date", () => {
      expect(formatLocalDateTime(null)).toBeNull();
    });

    it("returns null for invalid date", () => {
      expect(formatLocalDateTime("not-a-date")).toBeNull();
    });

    it("formats valid date with timezone info", () => {
      const result = formatLocalDateTime("2026-03-15T14:30:00Z");
      expect(result).not.toBeNull();
      expect(result).toContain("2026");
      expect(result).toContain("Mar");
      expect(result).toContain("15");
      expect(result).toContain("30");
      expect(result).toContain("GMT");
      expect(result).toContain("(");
      expect(result).toContain(")");
    });
  });
});
