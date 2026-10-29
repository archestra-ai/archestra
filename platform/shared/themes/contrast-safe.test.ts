import { describe, expect, test } from "vitest";
import {
  contrastRatio,
  withAccessibleDarkTokens,
  withAccessibleLightTokens,
} from "./contrast-safe";
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

  test("keeps a tinted input outline in the theme's colour instead of greying it", () => {
    const out = withAccessibleLightTokens({
      background: "oklch(0.97 0.01 286.15)",
      primary: "oklch(0.54 0.18 288.03)",
      input: "oklch(0.91 0.02 285.96)", // pale lavender, ~1.2:1
    });
    expect(
      contrastRatio(out.input, "oklch(0.97 0.01 286.15)") as number,
    ).toBeGreaterThanOrEqual(3);
    // Hue is kept and chroma borrowed from the accent, so it stays purple.
    const [, chroma, hue] = out.input.slice(6, -1).split(" ");
    expect(Number(hue)).toBeCloseTo(285.96);
    expect(Number(chroma)).toBeGreaterThan(0.04);
  });

  test("keeps a neutral input outline neutral", () => {
    const out = withAccessibleLightTokens({
      background: "oklch(1 0 0)",
      primary: "oklch(0.54 0.18 288.03)",
      input: "oklch(0.92 0 0)",
    });
    expect(out.input).toMatch(/ 0 0\)$/);
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

  test("raises muted text to 4.5:1 on the sidebar, not just on muted and the page", () => {
    const out = withAccessibleLightTokens({
      background: "oklch(0.98 0 0)",
      muted: "oklch(0.9 0 0)",
      sidebar: "oklch(0.88 0 0)", // darker than muted and the page
      "muted-foreground": "oklch(0.52 0 0)",
    });
    expect(
      contrastRatio(out["muted-foreground"], "oklch(0.88 0 0)") as number,
    ).toBeGreaterThanOrEqual(4.5);
  });

  test("steps a sidebar hover fill that matches the sidebar toward the text colour", () => {
    const light = withAccessibleLightTokens({
      sidebar: "oklch(0.955 0.004 78.3)",
      "sidebar-accent": "oklch(0.95 0.008 73.7)",
    });
    expect(
      contrastRatio(light["sidebar-accent"], "oklch(0.955 0.004 78.3)"),
    ).toBeGreaterThanOrEqual(1.1);
    expect(lightness(light["sidebar-accent"])).toBeLessThan(0.955);

    const dark = withAccessibleDarkTokens({
      sidebar: "oklch(0.21 0.01 285)",
      "sidebar-accent": "oklch(0.21 0.01 285)",
    });
    expect(
      contrastRatio(dark["sidebar-accent"], "oklch(0.21 0.01 285)"),
    ).toBeGreaterThanOrEqual(1.1);
    expect(lightness(dark["sidebar-accent"])).toBeGreaterThan(0.21);
  });

  test("keeps a muted fill on the side of the page the theme put it", () => {
    // A muted track lighter than its page must not jump to the darker side.
    const out = withAccessibleLightTokens({
      background: "oklch(0.94 0 0)",
      muted: "oklch(0.97 0 0)",
    });
    expect(contrastRatio(out.muted, "oklch(0.94 0 0)")).toBeGreaterThanOrEqual(
      1.1,
    );
    expect(lightness(out.muted)).toBeGreaterThan(0.97);
  });

  test("darkens a selected-item pill instead of turning its white label black", () => {
    const out = withAccessibleLightTokens({
      sidebar: "oklch(0.86 0.03 49.57)",
      "sidebar-accent": "oklch(0.73 0.05 52.33)", // white on it is ~2.4:1
      "sidebar-accent-foreground": "oklch(1 0 0)",
    });
    expect(out["sidebar-accent-foreground"]).toBe("oklch(1 0 0)");
    expect(
      contrastRatio(out["sidebar-accent-foreground"], out["sidebar-accent"]),
    ).toBeGreaterThanOrEqual(4.5);
    expect(out["sidebar-accent"]).toMatch(/ 0\.05 52\.33\)$/);
  });

  test("leaves dark-mode borders, inputs and focus rings verbatim", () => {
    const dark = {
      background: "oklch(0.2 0 0)",
      sidebar: "oklch(0.2 0 0)",
      border: "oklch(0.22 0 0)",
      input: "oklch(0.25 0 0)",
      ring: "oklch(0.3 0 0)",
      "sidebar-border": "oklch(0.21 0 0)",
      "sidebar-ring": "oklch(0.3 0 0)",
    };
    expect(withAccessibleDarkTokens(dark)).toEqual(dark);
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

  test("every shipped theme, in both modes, keeps sidebar and muted surfaces readable and distinct", () => {
    for (const theme of getSupportedThemeItems()) {
      for (const [mode, original, out] of [
        [
          "light",
          theme.cssVars.light,
          withAccessibleLightTokens(theme.cssVars.light),
        ],
        [
          "dark",
          theme.cssVars.dark,
          withAccessibleDarkTokens(theme.cssVars.dark),
        ],
      ] as const) {
        const label = (what: string) => `${theme.name} ${mode}: ${what}`;
        const ratio = (a: string, b: string) => contrastRatio(a, b) as number;

        // Selected/hovered sidebar items and tab-picker tracks are visible.
        expect(
          ratio(out["sidebar-accent"], out.sidebar),
          label("sidebar-accent vs sidebar"),
        ).toBeGreaterThanOrEqual(1.1);
        expect(
          ratio(out.muted, out.background),
          label("muted vs background"),
        ).toBeGreaterThanOrEqual(1.1);

        // Text: WCAG 1.4.3, 4.5:1, on every surface it is drawn on.
        for (const [text, surface] of [
          ["sidebar-foreground", "sidebar"],
          ["sidebar-accent-foreground", "sidebar-accent"],
          ["muted-foreground", "muted"],
          ["muted-foreground", "background"],
          ["muted-foreground", "sidebar"],
        ] as const) {
          expect(
            ratio(out[text], out[surface]),
            label(`${text} on ${surface}`),
          ).toBeGreaterThanOrEqual(4.5);
        }

        // Character is kept: an adjusted token changes lightness only (the
        // light input outline may borrow accent chroma, covered above).
        for (const [token, value] of Object.entries(out)) {
          if (value === original[token] || token === "input") continue;
          expect(
            withoutLightness(value),
            label(`${token} keeps chroma and hue`),
          ).toBe(withoutLightness(original[token]));
        }
      }
    }
  });
});

function lightness(oklch: string): number {
  return Number.parseFloat(oklch.slice("oklch(".length));
}

function withoutLightness(oklch: string): string {
  return oklch
    .slice("oklch(".length, -1)
    .trim()
    .split(/\s+/)
    .slice(1)
    .join(" ");
}
