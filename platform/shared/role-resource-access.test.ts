import { describe, expect, it } from "vitest";
import {
  allowedFromCatalog,
  collapseAllowList,
  isResourceAllowed,
  unionAllowLists,
} from "./role-resource-access";

const CATALOG = ["openai", "anthropic", "gemini"] as const;

describe("isResourceAllowed", () => {
  it("treats a missing list as unrestricted", () => {
    expect(isResourceAllowed(null, "openai")).toBe(true);
    expect(isResourceAllowed(undefined, "openai")).toBe(true);
  });

  it("treats an empty list as nothing allowed", () => {
    expect(isResourceAllowed([], "openai")).toBe(false);
  });

  it("allows only what the list names", () => {
    expect(isResourceAllowed(["openai"], "openai")).toBe(true);
    expect(isResourceAllowed(["openai"], "anthropic")).toBe(false);
  });
});

describe("allowedFromCatalog", () => {
  it("returns the whole catalog when unrestricted", () => {
    expect(allowedFromCatalog(null, CATALOG)).toEqual([...CATALOG]);
  });

  it("keeps catalog order rather than list order", () => {
    expect(allowedFromCatalog(["gemini", "openai"], CATALOG)).toEqual([
      "openai",
      "gemini",
    ]);
  });

  it("ignores ids this build no longer knows", () => {
    expect(allowedFromCatalog(["openai", "retired-provider"], CATALOG)).toEqual(
      ["openai"],
    );
  });

  it("returns nothing for an empty list", () => {
    expect(allowedFromCatalog([], CATALOG)).toEqual([]);
  });
});

describe("collapseAllowList", () => {
  it("collapses a full selection to unrestricted so later entries stay available", () => {
    expect(collapseAllowList([...CATALOG], CATALOG)).toBeNull();
  });

  it("stores an empty list when every chip was removed", () => {
    expect(collapseAllowList([], CATALOG)).toEqual([]);
  });

  it("stores a partial selection in catalog order", () => {
    expect(collapseAllowList(["gemini", "openai"], CATALOG)).toEqual([
      "openai",
      "gemini",
    ]);
  });

  it("drops selected ids that are not in the catalog", () => {
    expect(collapseAllowList(["openai", "ghost"], CATALOG)).toEqual(["openai"]);
  });
});

describe("unionAllowLists", () => {
  it("is unrestricted when any role is unrestricted", () => {
    expect(unionAllowLists([["openai"], null])).toBeNull();
  });

  it("merges the restricted lists", () => {
    expect(unionAllowLists([["openai"], ["gemini", "openai"]])?.sort()).toEqual(
      ["gemini", "openai"],
    );
  });

  it("is empty when every role allows nothing", () => {
    expect(unionAllowLists([[], []])).toEqual([]);
  });
});
