// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The terminal tokens are mixed from each theme's own `--card`/`--foreground`,
 * so their contrast is a property of 24 themes × 2 modes that no one can check
 * by eye. This recomputes the same oklab mixes the browser does and asserts the
 * resulting ratios, which catches a mix percentage drifting too close to the
 * surface, or a new theme shipping a palette the formula cannot carry.
 */

const CSS_DIR = join(__dirname, "..", "app");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const globals = strip(readFileSync(join(CSS_DIR, "globals.css"), "utf8"));
const themesCss = strip(readFileSync(join(CSS_DIR, "themes.css"), "utf8"));

type Rgb = [number, number, number];

const clamp = (v: number) => Math.min(1, Math.max(0, v));

function fromOklab([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function toOklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Parse the color notations themes.css and globals.css actually use. */
function parse(color: string): Rgb {
  const value = color.trim();
  if (value === "black") return [0, 0, 0];
  if (value === "white") return [1, 1, 1];
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    return [0, 2, 4].map((i) => {
      const s = Number.parseInt(hex[1].slice(i, i + 2), 16) / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as Rgb;
  }
  const ok = value.match(/oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/i);
  if (!ok) throw new Error(`Unsupported color: ${color}`);
  const l = ok[1].endsWith("%")
    ? Number.parseFloat(ok[1]) / 100
    : Number.parseFloat(ok[1]);
  const c = Number.parseFloat(ok[2]);
  const h = (Number.parseFloat(ok[3]) * Math.PI) / 180;
  return fromOklab([l, c * Math.cos(h), c * Math.sin(h)]);
}

/** `color-mix(in oklab, a <pct>%, b)`. */
function mix(a: Rgb, b: Rgb, pct: number): Rgb {
  const [x, y] = [toOklab(a), toOklab(b)];
  return fromOklab(x.map((v, i) => v * pct + y[i] * (1 - pct)) as Rgb);
}

function contrast(a: Rgb, b: Rgb): number {
  const luminance = (c: Rgb) =>
    0.2126 * clamp(c[0]) + 0.7152 * clamp(c[1]) + 0.0722 * clamp(c[2]);
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The mix percentage globals.css uses, so the test follows the real values. */
function mixPercent(token: string, { dark = false } = {}): number {
  // `:root` comes first in globals.css and `html.dark` after it, so a token
  // that dark mode redefines has its dark value in the last match.
  const matches = [
    ...globals.matchAll(
      new RegExp(`${token}:\\s*color-mix\\(in oklab,[^%]*?([\\d.]+)%`, "g"),
    ),
  ];
  const match = dark ? matches.at(-1) : matches[0];
  if (!match) throw new Error(`No color-mix percentage for ${token}`);
  return Number.parseFloat(match[1]) / 100;
}

function themeTokens(): [string, Record<string, string>][] {
  const themes: [string, Record<string, string>][] = [];
  for (const [, selector, body] of themesCss.matchAll(
    /(html[^{]*)\{([^}]*)\}/g,
  )) {
    const named = selector.trim().match(/^html(\.dark)?\.theme-([\w-]+)$/);
    if (!named) continue;
    const tokens: Record<string, string> = {};
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens[name] = value.trim();
    }
    themes.push([`${named[2]} ${named[1] ? "dark" : "light"}`, tokens]);
  }
  return themes;
}

/** Resolve the terminal palette the browser computes for one theme and mode. */
function terminalPalette(theme: Record<string, string>, dark: boolean) {
  const anchor = parse(dark ? "white" : "black");
  const surface = mix(
    parse(theme[dark ? "--card" : "--muted"]),
    parse(theme["--foreground"]),
    mixPercent("--terminal", { dark }),
  );
  const foreground = mix(
    parse(theme["--foreground"]),
    anchor,
    mixPercent("--terminal-foreground"),
  );
  return {
    surface,
    foreground,
    emphasis: anchor,
    elevated: mix(surface, foreground, mixPercent("--terminal-elevated")),
    selected: mix(surface, foreground, mixPercent("--terminal-selected")),
    muted: mix(foreground, surface, mixPercent("--terminal-muted")),
    comment: mix(foreground, surface, mixPercent("--terminal-comment")),
    success: mix(
      parse("#22c55e"),
      foreground,
      mixPercent("--terminal-success"),
    ),
    destructive: mix(
      parse("#ef4444"),
      foreground,
      mixPercent("--terminal-destructive"),
    ),
  };
}

describe("terminal surface contrast", () => {
  const themes = themeTokens();

  it("covers every selectable theme in both modes", () => {
    expect(themes).toHaveLength(48);
  });

  it.each(themes)("keeps %s legible", (name, tokens) => {
    const palette = terminalPalette(tokens, name.endsWith("dark"));

    // Code is text the reader has to transcribe, so WCAG AA applies to it and
    // to the dimmer label/comment tiers rendered beside it.
    for (const ink of [
      palette.foreground,
      palette.muted,
      palette.comment,
      palette.emphasis,
      palette.destructive,
    ]) {
      expect(contrast(ink, palette.surface)).toBeGreaterThanOrEqual(4.5);
    }
    // Copy/reveal controls sit on the raised fill rather than the surface.
    expect(contrast(palette.muted, palette.elevated)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrast(palette.emphasis, palette.elevated)).toBeGreaterThanOrEqual(
      4.5,
    );
    // A selected tab has to stand apart from the strip, and its label stays
    // legible on the selected fill.
    expect(contrast(palette.selected, palette.surface)).toBeGreaterThanOrEqual(
      1.3,
    );
    expect(
      contrast(palette.foreground, palette.selected),
    ).toBeGreaterThanOrEqual(4.5);
    // The copied tick is a state graphic, so the 3:1 non-text bar applies.
    expect(contrast(palette.success, palette.elevated)).toBeGreaterThanOrEqual(
      3,
    );
  });
});

describe("sidebar emphasis contrast", () => {
  const themes = themeTokens();
  const sidebarEmphasis = (name: string, tokens: Record<string, string>) =>
    mix(
      parse(tokens["--sidebar-foreground"]),
      parse(name.endsWith("dark") ? "white" : "black"),
      mixPercent("--sidebar-emphasis"),
    );

  it.each(
    themes.filter(([name]) => name.endsWith("light")),
  )("keeps %s chips and selected segment legible without heavy outlines", (name, tokens) => {
    const emphasis = sidebarEmphasis(name, tokens);
    const chip = mix(
      emphasis,
      parse(tokens["--sidebar"]),
      mixPercent("--sidebar-chip"),
    );

    // "New"/"Beta" chips: emphasis text on the soft tinted fill.
    expect(contrast(emphasis, chip)).toBeGreaterThanOrEqual(4.5);
    // Selected AI/Studio segment: foreground text on a background card.
    expect(
      contrast(parse(tokens["--foreground"]), parse(tokens["--background"])),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each(
    themes.filter(([name]) => name.endsWith("dark")),
  )("keeps %s chips and selected segment legible", (name, tokens) => {
    const emphasis = sidebarEmphasis(name, tokens);

    // Outlined "New"/"Beta" chips: emphasis text and edge on the sidebar.
    // The selected AI/Studio segment: sidebar text on an emphasis fill, set
    // against the muted track the unselected segment shares.
    expect(
      contrast(emphasis, parse(tokens["--sidebar"])),
    ).toBeGreaterThanOrEqual(4.5);
    expect(contrast(emphasis, parse(tokens["--muted"]))).toBeGreaterThanOrEqual(
      4.5,
    );
  });
});

describe("sidebar attention contrast", () => {
  const themes = themeTokens();

  it.each(
    themes,
  )("keeps the %s attention count and dot legible", (name, tokens) => {
    const sidebar = parse(tokens["--sidebar"]);
    const ink = mix(
      parse(tokens["--destructive"]),
      parse(name.endsWith("dark") ? "white" : "black"),
      mixPercent("--sidebar-attention-foreground"),
    );
    const fill = mix(
      parse(tokens["--destructive"]),
      sidebar,
      mixPercent("--sidebar-attention"),
    );

    // The count is text on its tinted fill; the dot is a 3:1 state graphic.
    expect(contrast(ink, fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ink, sidebar)).toBeGreaterThanOrEqual(3);
  });
});

describe("sidebar segmented toggle", () => {
  it.each(
    themeTokens(),
  )("keeps the %s AI/Studio track visible against the sidebar", (_name, tokens) => {
    const sidebar = parse(tokens["--sidebar"]);
    const track = mix(
      parse(tokens["--sidebar-foreground"]),
      sidebar,
      mixPercent("--sidebar-track"),
    );
    // The track reads as one control through its fill or its outline (a
    // near-black sidebar flattens the fill's luminance step, but such
    // themes ship a strong --sidebar-border).
    const fillStep = contrast(track, sidebar);
    const outline = contrast(parse(tokens["--sidebar-border"]), sidebar);
    expect(fillStep >= 1.1 || outline >= 1.3).toBe(true);
  });
});
