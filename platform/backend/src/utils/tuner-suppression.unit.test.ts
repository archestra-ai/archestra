import { describe, expect, test } from "vitest";
import {
  EMPTY_FINGERPRINT_HISTORY,
  suppressionVerdict,
} from "./tuner-suppression";

const now = new Date("2026-11-16T12:00:00Z");
const daysAgo = (days: number) =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

describe("suppressionVerdict", () => {
  test("a fingerprint without history is new", () => {
    expect(suppressionVerdict(EMPTY_FINGERPRINT_HISTORY, "info", now)).toEqual({
      type: "new",
    });
  });

  test("an open suggestion is superseded only by a higher severity", () => {
    const history = {
      active: { id: "a", status: "open" as const, severity: "warn" as const },
      lastClosed: null,
    };
    expect(suppressionVerdict(history, "warn", now)).toEqual({
      type: "suppressed",
      reason: "open_suggestion",
    });
    expect(suppressionVerdict(history, "info", now).type).toBe("suppressed");
    expect(suppressionVerdict(history, "critical", now)).toEqual({
      type: "supersede",
      activeId: "a",
    });
  });

  test("a published change blocks every severity", () => {
    const history = {
      active: {
        id: "a",
        status: "published" as const,
        severity: "info" as const,
      },
      lastClosed: null,
    };
    expect(suppressionVerdict(history, "critical", now)).toEqual({
      type: "suppressed",
      reason: "change_in_flight",
    });
  });

  test("done or rejected suppress within the window unless severity rose", () => {
    for (const status of ["done", "rejected"] as const) {
      const recent = {
        active: null,
        lastClosed: {
          status,
          severity: "warn" as const,
          statusChangedAt: daysAgo(13),
        },
      };
      expect(suppressionVerdict(recent, "warn", now)).toEqual({
        type: "suppressed",
        reason: "recently_closed",
      });
      expect(suppressionVerdict(recent, "critical", now)).toEqual({
        type: "new",
      });
    }
  });

  test("the window ends after the suppression period", () => {
    const history = {
      active: null,
      lastClosed: {
        status: "rejected" as const,
        severity: "critical" as const,
        statusChangedAt: daysAgo(14),
      },
    };
    expect(suppressionVerdict(history, "info", now)).toEqual({ type: "new" });
  });
});
