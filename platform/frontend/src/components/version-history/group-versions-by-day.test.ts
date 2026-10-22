// @vitest-environment node
import { describe, expect, it } from "vitest";
import { groupVersionsByDay } from "./group-versions-by-day";

const version = (n: number, createdAt: string) => ({ version: n, createdAt });

describe("groupVersionsByDay", () => {
  it("collapses versions made on the same day into one group", () => {
    const groups = groupVersionsByDay([
      version(3, "2026-08-03T18:00:00.000Z"),
      version(2, "2026-08-03T09:00:00.000Z"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.versions.map((v) => v.version)).toEqual([3, 2]);
  });

  it("starts a new group when the day changes", () => {
    const groups = groupVersionsByDay([
      version(3, "2026-08-03T09:00:00.000Z"),
      version(2, "2026-08-02T09:00:00.000Z"),
      version(1, "2026-08-01T09:00:00.000Z"),
    ]);

    expect(groups.map((group) => group.versions.map((v) => v.version))).toEqual(
      [[3], [2], [1]],
    );
  });

  it("keeps the order it was given rather than sorting", () => {
    // A version out of sequence gets its own group instead of being folded
    // into the earlier group for that day, which would reorder the timeline.
    const groups = groupVersionsByDay([
      version(3, "2026-08-03T09:00:00.000Z"),
      version(2, "2026-08-02T09:00:00.000Z"),
      version(1, "2026-08-03T09:00:00.000Z"),
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[0]?.label).toBe(groups[2]?.label);
  });

  it("tells the same day of different years apart", () => {
    const groups = groupVersionsByDay([
      version(2, "2025-08-03T09:00:00.000Z"),
      version(1, "2024-08-03T09:00:00.000Z"),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.label).not.toBe(groups[1]?.label);
  });

  it("has no groups for no versions", () => {
    expect(groupVersionsByDay([])).toEqual([]);
  });
});
