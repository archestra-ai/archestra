import { afterEach, describe, expect, it } from "vitest";
import {
  RESTORE_REMEMBERED_THEME_SCRIPT,
  THEME_STORAGE_KEY,
} from "./theme-storage";

describe("RESTORE_REMEMBERED_THEME_SCRIPT", () => {
  afterEach(() => {
    document.documentElement.className = "";
    localStorage.clear();
  });

  it("paints the theme this browser last saw instead of the server's default", () => {
    document.documentElement.className = "font-vars theme-caffeine";
    localStorage.setItem(THEME_STORAGE_KEY, "cosmic-night");

    runScript();

    expect([...document.documentElement.classList]).toEqual([
      "font-vars",
      "theme-cosmic-night",
    ]);
  });

  it("keeps the server's default theme when nothing usable is remembered", () => {
    document.documentElement.className = "theme-caffeine";

    runScript();
    expect(document.documentElement.className).toBe("theme-caffeine");

    localStorage.setItem(THEME_STORAGE_KEY, "not-a-theme");
    runScript();
    expect(document.documentElement.className).toBe("theme-caffeine");
  });
});

function runScript() {
  new Function(RESTORE_REMEMBERED_THEME_SCRIPT)();
}
