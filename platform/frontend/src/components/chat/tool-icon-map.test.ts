// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildToolIconMap } from "./tool-icon-map";

const catalogItems = [
  {
    id: "cat-docs",
    name: "Archestra Docs",
    icon: "data:image/svg+xml;base64,AA",
  },
  { id: "cat-github", name: "GitHub", icon: "🐙" },
];

describe("buildToolIconMap", () => {
  it("resolves a tool assigned to the agent through its catalog", () => {
    const map = buildToolIconMap({
      agentTools: [{ name: "renamed_tool", catalogId: "cat-github" }],
      catalogItems,
    });

    expect(map.get("renamed_tool")).toEqual({
      icon: "🐙",
      catalogId: "cat-github",
    });
  });

  it("resolves a tool reached without an assignment by its server prefix", () => {
    const map = buildToolIconMap({ agentTools: [], catalogItems });

    expect(map.get("archestra_docs__search_docs")).toEqual({
      icon: "data:image/svg+xml;base64,AA",
      catalogId: "cat-docs",
    });
  });

  it("returns nothing for a tool with no matching catalog", () => {
    const map = buildToolIconMap({ agentTools: [], catalogItems });

    expect(map.get("unknown_server__tool")).toBeUndefined();
    expect(map.get("no_separator")).toBeUndefined();
  });
});
