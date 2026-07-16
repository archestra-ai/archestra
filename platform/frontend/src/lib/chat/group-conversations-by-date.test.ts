import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDateBucketLabel,
  groupConversationsByDay,
} from "@/lib/chat/group-conversations-by-date";

// date-fns buckets by LOCAL calendar days, so fixtures use local-time Date
// constructors (never UTC ISO strings) to stay timezone-independent.
const at = (day: number, hour: number) =>
  new Date(2026, 6 /* July */, day, hour);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(16, 12));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getDateBucketLabel", () => {
  it("labels today and yesterday by name", () => {
    expect(getDateBucketLabel(at(16, 8))).toBe("Today");
    expect(getDateBucketLabel(at(15, 23))).toBe("Yesterday");
  });

  it("labels the rest of the last week with the day date", () => {
    expect(getDateBucketLabel(at(14, 12))).toBe("Jul 14");
    expect(getDateBucketLabel(at(10, 0))).toBe("Jul 10");
  });

  it("labels anything before the last week as Older", () => {
    expect(getDateBucketLabel(at(9, 23))).toBe("Older");
    expect(getDateBucketLabel(new Date(2026, 0, 1))).toBe("Older");
  });

  it("labels future dates (clock skew) as Today, not Older", () => {
    expect(getDateBucketLabel(at(17, 0))).toBe("Today");
  });

  it("falls back to Older for invalid dates instead of throwing", () => {
    expect(getDateBucketLabel("not-a-date")).toBe("Older");
  });

  it("accepts Date and string timestamps interchangeably", () => {
    expect(getDateBucketLabel(at(16, 8).toISOString())).toBe("Today");
  });
});

describe("groupConversationsByDay", () => {
  const conv = (id: string, lastMessageAt: Date) => ({ id, lastMessageAt });

  it("returns ordered per-day groups following input order", () => {
    const result = groupConversationsByDay(
      [
        conv("t1", at(16, 10)),
        conv("t2", at(16, 8)),
        conv("y1", at(15, 12)),
        conv("d14", at(14, 12)),
        conv("d12", at(12, 12)),
        conv("o1", at(1, 12)),
        conv("o2", new Date(2026, 0, 1)),
      ],
      (c) => c.lastMessageAt,
    );

    expect(result.map((g) => [g.label, g.chats.map((c) => c.id)])).toEqual([
      ["Today", ["t1", "t2"]],
      ["Yesterday", ["y1"]],
      ["Jul 14", ["d14"]],
      ["Jul 12", ["d12"]],
      ["Older", ["o1", "o2"]],
    ]);
  });

  it("omits empty buckets", () => {
    const result = groupConversationsByDay(
      [conv("t1", at(16, 10)), conv("o1", at(1, 12))],
      (c) => c.lastMessageAt,
    );

    expect(result.map((g) => g.label)).toEqual(["Today", "Older"]);
  });

  it("returns an empty array for an empty list", () => {
    expect(groupConversationsByDay([], () => new Date())).toEqual([]);
  });
});
