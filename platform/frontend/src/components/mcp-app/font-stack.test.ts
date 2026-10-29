import { describe, expect, it } from "vitest";
import { withGenericFontFallback } from "./font-stack";

describe("withGenericFontFallback", () => {
  it("appends a sans-serif fallback to a bundled-font-only stack", () => {
    expect(
      withGenericFontFallback("'Geist', 'Geist Fallback'", "sans-serif"),
    ).toBe("'Geist', 'Geist Fallback', ui-sans-serif, system-ui, sans-serif");
  });

  it("keeps a stack that already ends in the generic family", () => {
    expect(withGenericFontFallback("Geist Mono, monospace", "monospace")).toBe(
      "Geist Mono, monospace",
    );
  });

  it("uses the fallback alone when the theme defines no font", () => {
    expect(withGenericFontFallback("", "monospace")).toBe(
      "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    );
  });
});
