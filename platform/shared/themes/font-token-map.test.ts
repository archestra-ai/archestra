import { describe, expect, test } from "vitest";
import { mapThemeFontValue } from "./font-token-map";

describe("mapThemeFontValue", () => {
  test("maps loaded sans fonts to next/font CSS variables", () => {
    expect(mapThemeFontValue("Inter, sans-serif")).toBe("var(--font-inter)");
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
    expect(mapThemeFontValue("Geist, sans-serif")).toBe("Geist, sans-serif");
    expect(
      mapThemeFontValue(
        "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif",
      ),
    ).toBe(
      "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif",
    );
  });
});
