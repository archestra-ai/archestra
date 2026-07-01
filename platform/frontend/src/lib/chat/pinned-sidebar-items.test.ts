import { describe, expect, it } from "vitest";
import { buildPinnedSidebarItems } from "@/lib/chat/pinned-sidebar-items";

describe("buildPinnedSidebarItems", () => {
  it("interleaves chats and projects sorted by pinnedAt desc", () => {
    const chats = [
      { id: "c1", pinnedAt: "2026-06-01T00:00:00.000Z" },
      { id: "c2", pinnedAt: "2026-06-05T00:00:00.000Z" },
    ];
    const projects = [{ id: "p1", pinnedAt: "2026-06-03T00:00:00.000Z" }];

    const result = buildPinnedSidebarItems({ chats, projects });

    expect(result.map((r) => [r.type, r.item.id])).toEqual([
      ["chat", "c2"],
      ["project", "p1"],
      ["chat", "c1"],
    ]);
  });

  it("excludes items without a pinnedAt", () => {
    const chats = [
      { id: "c1", pinnedAt: null },
      { id: "c2", pinnedAt: "2026-06-05T00:00:00.000Z" },
    ];
    const projects = [{ id: "p1", pinnedAt: undefined }];

    const result = buildPinnedSidebarItems({ chats, projects });

    expect(result.map((r) => r.item.id)).toEqual(["c2"]);
  });

  it("returns empty when nothing is pinned", () => {
    expect(buildPinnedSidebarItems({ chats: [], projects: [] })).toEqual([]);
  });

  it("accepts Date and string pinnedAt interchangeably", () => {
    const chats = [
      { id: "c1", pinnedAt: new Date("2026-06-10T00:00:00.000Z") },
    ];
    const projects = [{ id: "p1", pinnedAt: "2026-06-09T00:00:00.000Z" }];

    const result = buildPinnedSidebarItems({ chats, projects });

    expect(result.map((r) => r.item.id)).toEqual(["c1", "p1"]);
  });
});
