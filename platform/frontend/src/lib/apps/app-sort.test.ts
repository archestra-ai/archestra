import { describe, expect, test } from "vitest";
import { sortAppsPinnedFirst } from "./app-sort";

describe("sortAppsPinnedFirst", () => {
  test("puts pinned apps first, newest pin first", () => {
    const apps = [
      { id: "unpinned-first", pinnedAt: null },
      { id: "older-pin", pinnedAt: "2026-01-01T00:00:00.000Z" },
      { id: "unpinned-second", pinnedAt: null },
      { id: "newer-pin", pinnedAt: "2026-01-03T00:00:00.000Z" },
    ];

    expect(sortAppsPinnedFirst(apps).map((app) => app.id)).toEqual([
      "newer-pin",
      "older-pin",
      "unpinned-first",
      "unpinned-second",
    ]);
  });
});
