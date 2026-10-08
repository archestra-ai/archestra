import { describe, expect, test } from "vitest";
import { installAttachment, sameAttachment } from "./openappa-batteries.query";

describe("installAttachment", () => {
  test("a detected row attaches to its detected server", () => {
    expect(
      installAttachment({
        kind: "detected",
        catalogId: null,
        detectedId: "claude-code.slack",
      }),
    ).toEqual({ kind: "detected", detectedId: "claude-code.slack" });
  });

  test("a catalog row attaches to its catalog entry", () => {
    expect(
      installAttachment({
        kind: "catalog",
        catalogId: "cat-1",
        detectedId: null,
      }),
    ).toEqual({ kind: "catalog", catalogId: "cat-1" });
  });

  test("an organization-wide row attaches to no server", () => {
    expect(
      installAttachment({
        kind: "organization",
        catalogId: null,
        detectedId: null,
      }),
    ).toBeNull();
  });
});

describe("sameAttachment", () => {
  test("compares kind and id together", () => {
    const detected = { kind: "detected" as const, detectedId: "x" };
    const catalog = { kind: "catalog" as const, catalogId: "x" };
    expect(sameAttachment(detected, { ...detected })).toBe(true);
    expect(sameAttachment(detected, catalog)).toBe(false);
    expect(sameAttachment(catalog, { kind: "catalog", catalogId: "y" })).toBe(
      false,
    );
  });
});
