import { describe, expect, test } from "vitest";
import { contrastRatio, withAccessibleLightTokens } from "./contrast-safe";
import { getSupportedThemeItems } from "./theme-utils";

describe("withAccessibleLightTokens", () => {
  test("raises a faint border to the 3:1 non-text minimum, preserving hue", () => {
    const out = withAccessibleLightTokens({
      background: "oklch(1 0 0)",
      border: "oklch(0.93 0.01 264.53)", // ~1.2:1 against white
    });
    const ratio = contrastRatio(out.border, "oklch(1 0 0)");
    expect(ratio).not.toBeNull();
    expect(ratio as number).toBeGreaterThanOrEqual(3);
    // Only lightness moves; chroma and hue are kept.
    expect(out.border).toMatch(/0\.01 264\.53\)$/);
  });

  test("raises muted text to the 4.5:1 body-text minimum", () => {
    const out = withAccessibleLightTokens({
      background: "oklch(0.98 0 0)",
      muted: "oklch(0.94 0 0)",
      "muted-foreground": "oklch(0.72 0 0)", // ~2.8:1 against muted
    });
    expect(
      contrastRatio(out["muted-foreground"], out.muted) as number,
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(out["muted-foreground"], out.background) as number,
    ).toBeGreaterThanOrEqual(4.5);
  });

  test("leaves already-compliant tokens byte-for-byte unchanged", () => {
    const input = {
      background: "oklch(1 0 0)",
      border: "oklch(0 0 0)", // 21:1 — far above target
    };
    expect(withAccessibleLightTokens(input).border).toBe(input.border);
  });

  test("leaves non-oklch and unrelated token values untouched", () => {
    const input = {
      background: "oklch(1 0 0)",
      border: "#ccc", // not an oklch() value — cannot be reasoned about
      radius: "0.5rem",
    };
    const out = withAccessibleLightTokens(input);
    expect(out.border).toBe("#ccc");
    expect(out.radius).toBe("0.5rem");
  });

  test("no-ops when the reference token is missing", () => {
    const input = { border: "oklch(0.93 0.01 264.53)" };
    expect(withAccessibleLightTokens(input).border).toBe(input.border);
  });

  test("every shipped light theme clears WCAG minimums for chrome and muted text", () => {
    for (const theme of getSupportedThemeItems()) {
      const light = withAccessibleLightTokens(theme.cssVars.light);
      const bg = light.background;
      const sidebar = light.sidebar ?? bg;
      const muted = light.muted ?? bg;

      expect(
        contrastRatio(light.border, bg),
        `${theme.name}: border vs background`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(light.input, bg),
        `${theme.name}: input vs background`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(light["sidebar-border"], sidebar),
        `${theme.name}: sidebar-border vs sidebar`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(light["muted-foreground"], muted),
        `${theme.name}: muted-foreground vs muted`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
