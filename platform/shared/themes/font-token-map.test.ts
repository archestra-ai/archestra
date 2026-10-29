import { describe, expect, test } from "vitest";
import { mapThemeFontValue } from "./font-token-map";

describe("mapThemeFontValue", () => {
  test("maps loaded sans fonts to next/font CSS variables", () => {
    expect(mapThemeFontValue("Inter, sans-serif")).toBe("var(--font-inter)");
    expect(mapThemeFontValue("Geist, ui-sans-serif, sans-serif")).toBe(
      "var(--font-geist)",
    );
    expect(mapThemeFontValue('"Open Sans", sans-serif')).toBe(
      "var(--font-open-sans)",
    );
    expect(mapThemeFontValue("Plus Jakarta Sans, sans-serif")).toBe(
      "var(--font-plus-jakarta-sans)",
    );
  });

  test("maps loaded serif and mono fonts to next/font CSS variables", () => {
    expect(mapThemeFontValue("Libre Baskerville, serif")).toBe(
      "var(--font-libre-baskerville)",
    );
    expect(mapThemeFontValue("JetBrains Mono, monospace")).toBe(
      "var(--font-jetbrains-mono)",
    );
    expect(mapThemeFontValue("Source Code Pro, monospace")).toBe(
      "var(--font-source-code-pro)",
    );
  });

  test("leaves unsupported or system font stacks unchanged", () => {
    expect(mapThemeFontValue("Comic Neue, sans-serif")).toBe(
      "Comic Neue, sans-serif",
    );
    expect(
      mapThemeFontValue(
        "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif",
      ),
    ).toBe(
      "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif",
    );
  });
});
