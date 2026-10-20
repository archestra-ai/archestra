// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("getThemeFontPreload", () => {
  let cwd: string;

  beforeEach(() => {
    // A build's static media, as next/font names the files.
    cwd = mkdtempSync(path.join(tmpdir(), "theme-font-"));
    const media = path.join(cwd, ".next", "static", "media");
    mkdirSync(media, { recursive: true });
    for (const file of [
      "Geist_Variable-s.0mrjj4bg00-he.woff2",
      "Inter_Variable-s.2c9hgjyh95y2f.woff2",
      "Inter_Variable_latin.2x6-bkdr9i-g6.woff2",
    ]) {
      writeFileSync(path.join(media, file), "");
    }
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preloads the latin subset of Inter for a theme set in Inter", async () => {
    const { getThemeFontPreload } = await import("./theme-font.server");

    expect(await getThemeFontPreload("cosmic-night")).toBe(
      "/_next/static/media/Inter_Variable_latin.2x6-bkdr9i-g6.woff2",
    );
  });

  it("preloads Geist for the default theme", async () => {
    const { getThemeFontPreload } = await import("./theme-font.server");

    expect(await getThemeFontPreload(null)).toBe(
      "/_next/static/media/Geist_Variable-s.0mrjj4bg00-he.woff2",
    );
  });

  it("preloads nothing for a font it does not list, or without a build", async () => {
    const { getThemeFontPreload } = await import("./theme-font.server");
    expect(await getThemeFontPreload("bubblegum")).toBeNull();

    vi.mocked(process.cwd).mockReturnValue(path.join(cwd, "missing"));
    vi.resetModules();
    const fresh = await import("./theme-font.server");
    expect(await fresh.getThemeFontPreload("cosmic-night")).toBeNull();
  });
});
