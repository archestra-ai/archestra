import { describe, expect, test } from "vitest";
import { contrastRatio, withAccessibleLightTokens } from "./contrast-safe";
import { getSupportedThemeItems } from "./theme-utils";

describe("withAccessibleLightTokens", () => {
  test("raises a faint input outline to the 3:1 non-text minimum, preserving hue", () => {
    const out = withAccessibleLightTokens({
      background: "oklch(1 0 0)",
      input: "oklch(0.93 0.01 264.53)", // ~1.2:1 against white
    });
    const ratio = contrastRatio(out.input, "oklch(1 0 0)");
    expect(ratio).not.toBeNull();
    expect(ratio as number).toBeGreaterThanOrEqual(3);
    // Only lightness moves; chroma and hue are kept.
    expect(out.input).toMatch(/0\.01 264\.53\)$/);
  });

  test("raises a faint focus ring to the 3:1 non-text minimum", () => {
    const out = withAccessibleLightTokens({
      background: "oklch(1 0 0)",
      ring: "oklch(0.85 0.1 70)", // pale amber, ~1.6:1 against white
    });
    expect(
      contrastRatio(out.ring, "oklch(1 0 0)") as number,
    ).toBeGreaterThanOrEqual(3);
  });

  test("keeps a soft decorative border soft instead of forcing it to 3:1", () => {
    const input = {
      background: "oklch(1 0 0)",
      border: "oklch(0.9 0.01 264.53)", // ~1.35:1 — a normal hairline
    };
    expect(withAccessibleLightTokens(input).border).toBe(input.border);
  });

  test("lifts a near-invisible decorative border only to the visibility floor", () => {
    const out = withAccessibleLightTokens({
      background: "oklch(1 0 0)",
      border: "oklch(0.96 0.01 264.53)", // ~1.1:1 — vanishes on most screens
    });
    const ratio = contrastRatio(out.border, "oklch(1 0 0)") as number;
    expect(ratio).toBeGreaterThanOrEqual(1.3);
    expect(ratio).toBeLessThan(1.5);
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

  test("every shipped light theme meets WCAG where it applies and keeps decorative lines soft", () => {
    for (const theme of getSupportedThemeItems()) {
      const original = theme.cssVars.light;
      const light = withAccessibleLightTokens(original);
      const bg = light.background;
      const sidebar = light.sidebar ?? bg;
      const muted = light.muted ?? bg;
      const ratio = (a: string, b: string) => contrastRatio(a, b) as number;

      // Control boundaries and focus indicators: WCAG 1.4.11, 3:1.
      expect(
        ratio(light.input, bg),
        `${theme.name}: input`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        ratio(light.ring, bg),
        `${theme.name}: ring`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        ratio(light["sidebar-ring"], sidebar),
        `${theme.name}: sidebar-ring`,
      ).toBeGreaterThanOrEqual(3);
      // Secondary text: WCAG 1.4.3, 4.5:1.
      expect(
        ratio(light["muted-foreground"], muted),
        `${theme.name}: muted-foreground vs muted`,
      ).toBeGreaterThanOrEqual(4.5);

      // Decorative lines stay visible but are never pushed toward 3:1: each
      // keeps the theme's own value unless that is below the visibility floor.
      for (const [token, surface] of [
        ["border", bg],
        ["sidebar-border", sidebar],
      ] as const) {
        const before = ratio(original[token], surface);
        const after = ratio(light[token], surface);
        expect(after, `${theme.name}: ${token} visible`).toBeGreaterThanOrEqual(
          1.3,
        );
        expect(
          after,
          `${theme.name}: ${token} not raised past the floor`,
        ).toBeLessThanOrEqual(Math.max(before, 1.4));
      }
    }
  });
});
