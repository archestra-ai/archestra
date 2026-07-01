import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRunTimestamp } from "./format-run-timestamp";

describe("formatRunTimestamp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Local time (no Z) so the today/yesterday day comparison is TZ-independent.
    vi.setSystemTime(new Date("2026-01-15T12:00:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("labels a same-day timestamp as 'Today at <time>'", () => {
    expect(formatRunTimestamp("2026-01-15T09:30:00")).toMatch(/^Today at /);
  });

  it("labels the previous day as 'Yesterday at <time>'", () => {
    expect(formatRunTimestamp("2026-01-14T23:30:00")).toMatch(/^Yesterday at /);
  });

  it("labels older dates with month + day, not Today/Yesterday", () => {
    const out = formatRunTimestamp("2026-01-05T09:30:00");
    expect(out).not.toMatch(/^(Today|Yesterday)/);
    expect(out).toMatch(/ at /);
  });
});
