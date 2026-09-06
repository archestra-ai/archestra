import { describe, expect, test } from "vitest";
import { formatTeamPath, getTeamDescendantIds } from "./team-hierarchy";

const teams = [
  { id: "root", name: "Company", parentId: null },
  { id: "group", name: "Product", parentId: "root" },
  { id: "team", name: "Platform", parentId: "group" },
  { id: "sibling", name: "Design", parentId: "group" },
  { id: "other", name: "Operations", parentId: null },
];

describe("team hierarchy", () => {
  test("finds descendants at every depth without including siblings", () => {
    expect(getTeamDescendantIds(teams, "root")).toEqual([
      "group",
      "team",
      "sibling",
    ]);
    expect(getTeamDescendantIds(teams, "group")).toEqual(["team", "sibling"]);
    expect(getTeamDescendantIds(teams, "team")).toEqual([]);
  });

  test("formats a team path from the root", () => {
    expect(formatTeamPath(teams, "team")).toBe("Company / Product / Platform");
  });

  test("terminates safely if invalid cyclic data is supplied", () => {
    const cyclic = [
      { id: "a", name: "A", parentId: "b" },
      { id: "b", name: "B", parentId: "a" },
    ];

    expect(getTeamDescendantIds(cyclic, "a")).toEqual(["b"]);
    expect(formatTeamPath(cyclic, "a")).toBe("B / A");
  });
});
