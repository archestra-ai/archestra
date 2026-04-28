import { describe, expect, test } from "vitest";
import {
  DARK_ONLY_THEMES,
  LIGHT_ONLY_THEMES,
  SUPPORTED_THEMES,
} from "./theme-config";
import { getThemeById, getThemeMetadata, getThemeRequiredMode } from "./theme-utils";

describe("getThemeRequiredMode", () => {
  test.each(DARK_ONLY_THEMES)("returns 'dark' for %s", (id) => {
    expect(getThemeRequiredMode(id)).toBe("dark");
  });

  test.each(LIGHT_ONLY_THEMES)("returns 'light' for %s", (id) => {
    expect(getThemeRequiredMode(id)).toBe("light");
  });

  test("returns null for themes that support both modes", () => {
    const restricted = new Set<string>([...DARK_ONLY_THEMES, ...LIGHT_ONLY_THEMES]);
    for (const id of SUPPORTED_THEMES) {
      if (!restricted.has(id)) {
        expect(getThemeRequiredMode(id)).toBeNull();
      }
    }
  });
});

describe("getThemeMetadata", () => {
  test("maps getThemeRequiredMode 'dark' result to mode: dark-only", () => {
    const metadata = getThemeMetadata();
    expect(metadata.find((t) => t.id === DARK_ONLY_THEMES[0])?.mode).toBe("dark-only");
  });

  test("maps getThemeRequiredMode 'light' result to mode: light-only", () => {
    const metadata = getThemeMetadata();
    expect(metadata.find((t) => t.id === LIGHT_ONLY_THEMES[0])?.mode).toBe("light-only");
  });

  test("omits mode for themes that support both modes", () => {
    const restricted = new Set<string>([...DARK_ONLY_THEMES, ...LIGHT_ONLY_THEMES]);
    const metadata = getThemeMetadata();
    for (const entry of metadata) {
      if (!restricted.has(entry.id)) {
        expect(entry.mode).toBeUndefined();
      }
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
