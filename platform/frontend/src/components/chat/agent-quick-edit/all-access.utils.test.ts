// @vitest-environment node
import { describe, expect, it } from "vitest";
import { listNames, summarizeAllToolAccess } from "./all-access.utils";

const catalogs = [
  { id: "archestra", name: "Archestra" },
  { id: "github", name: "GitHub" },
  { id: "jira", name: "Jira" },
  { id: "empty", name: "Not installed" },
];
const tools = [
  { id: "a1", catalogId: "archestra" },
  { id: "a2", catalogId: "archestra" },
  { id: "a3", catalogId: "archestra" },
  { id: "g1", catalogId: "github" },
  { id: "g2", catalogId: "github" },
  { id: "j1", catalogId: "jira" },
];

describe("summarizeAllToolAccess", () => {
  it("drops a server only when every one of its tools is excluded", () => {
    const summary = summarizeAllToolAccess({
      catalogs,
      tools,
      excludedToolIds: ["g1", "g2", "a3"],
    });

    expect(
      summary.servers.map(({ catalog, toolCount }) => [catalog.id, toolCount]),
    ).toEqual([
      ["archestra", 2],
      ["jira", 1],
    ]);
    expect(summary.toolCount).toBe(3);
    expect(summary.excluded).toBe("GitHub excluded · 1 other tool excluded");
  });

  it("counts the built-in server's exclusions apart from the user's", () => {
    const summary = summarizeAllToolAccess({
      catalogs,
      tools,
      excludedToolIds: ["a2", "a3", "g1"],
      builtInCatalogIds: new Set(["archestra"]),
    });

    expect(summary.excluded).toBe(
      "1 tool excluded · 2 built-in tools excluded by default",
    );
  });

  it("says nothing is excluded when nothing is", () => {
    const summary = summarizeAllToolAccess({
      catalogs,
      tools,
      excludedToolIds: [],
    });

    expect(summary.servers).toHaveLength(3);
    expect(summary.excluded).toBeNull();
  });
});

describe("listNames", () => {
  it("names a few and counts the rest", () => {
    expect(listNames(["A"], 3)).toBe("A");
    expect(listNames(["A", "B"], 3)).toBe("A and B");
    expect(listNames(["A", "B", "C", "D", "E"], 3)).toBe("A, B, C and 2 more");
  });
});
