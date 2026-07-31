import { describe, expect, test } from "vitest";
import { AppSlugSchema } from "./app";

describe("AppSlugSchema", () => {
  test("accepts a hyphen-separated lowercase slug", () => {
    expect(AppSlugSchema.parse("sales-dashboard")).toBe("sales-dashboard");
  });

  test("accepts a single word and digits", () => {
    expect(AppSlugSchema.safeParse("dashboard").success).toBe(true);
    expect(AppSlugSchema.safeParse("q4-2026").success).toBe(true);
  });

  test.each([
    ["uppercase", "Sales-Dashboard"],
    ["a space", "sales dashboard"],
    ["an underscore", "sales_dashboard"],
    ["a leading hyphen", "-sales"],
    ["a trailing hyphen", "sales-"],
    ["doubled hyphens", "sales--board"],
    ["a slash that would add a path segment", "sales/board"],
    ["a percent-encoded character", "sales%2Fboard"],
    ["empty", ""],
  ])("rejects %s", (_label, value) => {
    expect(AppSlugSchema.safeParse(value).success).toBe(false);
  });

  test("rejects a slug longer than 100 characters", () => {
    expect(AppSlugSchema.safeParse("a".repeat(100)).success).toBe(true);
    expect(AppSlugSchema.safeParse("a".repeat(101)).success).toBe(false);
  });

  test("rejects a uuid-shaped slug, which would shadow an app id", () => {
    // The run page resolves its segment against id OR slug, so a slug in uuid
    // shape could point at an app other than the one that owns that id.
    const result = AppSlugSchema.safeParse(
      "7b0839a1-4663-4371-a739-e5dac7f8c33e",
    );
    expect(result.success).toBe(false);
  });

  test("rejects `catalog`, which the /a/catalog route already owns", () => {
    // A static Next.js segment shadows the dynamic one, so this slug would
    // resolve to the external-app page instead of the app that claimed it.
    expect(AppSlugSchema.safeParse("catalog").success).toBe(false);
    // Only the exact segment is reserved.
    expect(AppSlugSchema.safeParse("catalog-viewer").success).toBe(true);
  });
});
