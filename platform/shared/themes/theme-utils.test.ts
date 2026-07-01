import { describe, expect, test } from "vitest";
import { SUPPORTED_THEMES } from "./theme-config";
import { getThemeById, getThemeMetadata } from "./theme-utils";

describe("getThemeMetadata", () => {
  test("returns an entry for every supported theme", () => {
    const metadata = getThemeMetadata();
    expect(metadata).toHaveLength(SUPPORTED_THEMES.length);
    for (const id of SUPPORTED_THEMES) {
      expect(metadata.find((t) => t.id === id)).toBeDefined();
    }
  });
});

describe("getThemeById", () => {
  test("returns metadata for a known theme", () => {
    const id = SUPPORTED_THEMES[0];
    expect(getThemeById(id)?.id).toBe(id);
  });

  test("returns undefined for an unknown id", () => {
    // @ts-expect-error — intentionally passing an invalid id
    expect(getThemeById("not-a-real-theme")).toBeUndefined();
  });
});
