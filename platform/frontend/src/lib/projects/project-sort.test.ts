import { describe, expect, test } from "vitest";
import { sortProjectsPinnedFirst } from "./project-sort";

describe("sortProjectsPinnedFirst", () => {
  test("puts pinned projects first, newest pin first", () => {
    const projects = [
      { id: "unpinned-first", pinnedAt: null },
      { id: "older-pin", pinnedAt: "2026-01-01T00:00:00.000Z" },
      { id: "unpinned-second", pinnedAt: null },
      { id: "newer-pin", pinnedAt: "2026-01-03T00:00:00.000Z" },
    ];

    expect(
      sortProjectsPinnedFirst(projects).map((project) => project.id),
    ).toEqual(["newer-pin", "older-pin", "unpinned-first", "unpinned-second"]);
  });
});
