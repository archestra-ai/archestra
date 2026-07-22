import { describe, expect, it } from "vitest";
import {
  clearCatalogEditParam,
  setCatalogEditParam,
} from "./catalog-edit-link";

describe("setCatalogEditParam", () => {
  it("adds the edit param to an empty search", () => {
    expect(setCatalogEditParam("", "cat-1")).toBe("edit=cat-1");
  });

  it("preserves existing params", () => {
    const result = new URLSearchParams(
      setCatalogEditParam("search=foo&labels=x", "cat-1"),
    );
    expect(result.get("search")).toBe("foo");
    expect(result.get("labels")).toBe("x");
    expect(result.get("edit")).toBe("cat-1");
  });

  it("overwrites an existing edit param", () => {
    expect(setCatalogEditParam("edit=old", "new")).toBe("edit=new");
  });
});

describe("clearCatalogEditParam", () => {
  it("removes the edit param", () => {
    expect(clearCatalogEditParam("edit=cat-1")).toBe("");
  });

  it("preserves other params", () => {
    const result = new URLSearchParams(
      clearCatalogEditParam("search=foo&edit=cat-1"),
    );
    expect(result.get("search")).toBe("foo");
    expect(result.has("edit")).toBe(false);
  });

  it("is a no-op when there is no edit param", () => {
    expect(clearCatalogEditParam("search=foo")).toBe("search=foo");
  });
});
