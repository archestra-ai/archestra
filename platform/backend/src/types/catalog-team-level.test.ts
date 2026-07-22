import { describe, expect, it } from "vitest";
import {
  CatalogTeamInputSchema,
  normalizeCatalogTeamInput,
} from "./catalog-team-level";

describe("normalizeCatalogTeamInput", () => {
  it("turns a bare id into a level-less assignment", () => {
    expect(normalizeCatalogTeamInput(["t1"])).toEqual([{ id: "t1" }]);
  });

  it("carries an explicit level through", () => {
    expect(normalizeCatalogTeamInput([{ id: "t1", level: "write" }])).toEqual([
      { id: "t1", level: "write" },
    ]);
  });

  it("accepts a mixed list of bare ids and level-bearing objects", () => {
    expect(
      normalizeCatalogTeamInput(["t1", { id: "t2", level: "use" }]),
    ).toEqual([{ id: "t1" }, { id: "t2", level: "use" }]);
  });

  it("keeps the last entry for a repeated id, dropping earlier ones", () => {
    // A caller that lists a team twice with conflicting levels resolves to the
    // last write, and the result carries the id only once.
    expect(
      normalizeCatalogTeamInput([
        { id: "t1", level: "use" },
        { id: "t1", level: "write" },
      ]),
    ).toEqual([{ id: "t1", level: "write" }]);
  });

  it("lets a later bare id clear an earlier explicit level for the same team", () => {
    // A bare id means "keep what is stored"; last-wins means the object's level
    // does not survive when a bare duplicate follows it.
    expect(
      normalizeCatalogTeamInput([{ id: "t1", level: "write" }, "t1"]),
    ).toEqual([{ id: "t1" }]);
  });

  it("returns an empty list for no teams", () => {
    expect(normalizeCatalogTeamInput([])).toEqual([]);
  });
});

describe("CatalogTeamInputSchema", () => {
  it("accepts a bare id string", () => {
    expect(CatalogTeamInputSchema.safeParse("t1").success).toBe(true);
  });

  it("accepts an object with an explicit level", () => {
    expect(
      CatalogTeamInputSchema.safeParse({ id: "t1", level: "use" }).success,
    ).toBe(true);
  });

  it("accepts an object without a level", () => {
    expect(CatalogTeamInputSchema.safeParse({ id: "t1" }).success).toBe(true);
  });

  it("rejects an empty id string", () => {
    expect(CatalogTeamInputSchema.safeParse("").success).toBe(false);
    expect(CatalogTeamInputSchema.safeParse({ id: "" }).success).toBe(false);
  });

  it("rejects an unknown level", () => {
    expect(
      CatalogTeamInputSchema.safeParse({ id: "t1", level: "owner" }).success,
    ).toBe(false);
  });
});
