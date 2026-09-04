/**
 * Contrast-safety pass for generated theme tokens.
 *
 * tweakcn's light palettes ship structural chrome (table/card/input borders,
 * dividers, unchecked control outlines) and muted text at contrast ratios far
 * below WCAG 2.2 minimums — most light themes render borders at ~1.2:1 against
 * their background, so table grids and bulk-action checkboxes are nearly
 * invisible. This module darkens only the offending tokens just enough to clear
 * the target ratio, preserving each theme's hue and chroma so the palette's
 * character is unchanged. It runs on the LIGHT variant only; dark mode is never
 * touched.
 *
 * WCAG 2.2 targets:
 *   - 1.4.11 Non-text Contrast: 3:1 for UI component boundaries/states
 *   - 1.4.3 Contrast (Minimum): 4.5:1 for body/secondary text
 */

/**
 * Raise the contrast of a light theme's structural and muted-text tokens to the
 * WCAG minimums, returning a new token map. Tokens already meeting their target
 * (or that are not plain `oklch()` values) are left byte-for-byte unchanged, so
 * high-contrast themes (e.g. neo-brutalism) and non-color tokens are untouched.
 */
export function withAccessibleLightTokens(
  light: Record<string, string>,
): Record<string, string> {
  const result = { ...light };
  for (const rule of CONTRAST_RULES) {
    const color = result[rule.token];
    if (!color) continue;
    const against = rule.against
      .map((key) => result[key])
      .filter((value): value is string => Boolean(value));
    if (against.length === 0) continue;
    result[rule.token] = ensureMinContrast(color, against, rule.ratio);
  }
  return result;
}

/**
 * WCAG contrast ratio between two colors, each an `oklch()` string. Returns
 * `null` if either value cannot be parsed as oklch.
 *
 * @public — reused by contrast-safe.test.ts to assert generated ratios.
 */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// ============================================================================
// Internal
// ============================================================================

interface ContrastRule {
  /** Token to adjust. */
  token: string;
  /** Reference token(s); the token must clear the target against each of them. */
  against: string[];
  /** Minimum WCAG contrast ratio to reach. */
  ratio: number;
}

/**
 * Tokens whose light-mode contrast we guarantee, and what each is seen against:
 *   - `border`   — table/card/popover borders and the default component border
 *   - `input`    — input outlines and unchecked checkbox/radio outlines
 *   - `sidebar-border` — sidebar dividers, seen against the sidebar surface
 *   - `muted-foreground` — secondary text, seen on both muted and base surfaces
 * Borders/outlines target 3:1 (1.4.11); muted text targets 4.5:1 (1.4.3).
 */
const CONTRAST_RULES: ContrastRule[] = [
  { token: "border", against: ["background"], ratio: 3 },
  { token: "input", against: ["background"], ratio: 3 },
  { token: "sidebar-border", against: ["sidebar", "background"], ratio: 3 },
  {
    token: "muted-foreground",
    against: ["muted", "background"],
    ratio: 4.5,
  },
];

/**
 * Small cushion added to every target so the adjusted value stays at or above
 * the WCAG minimum after the lightness is rounded for output.
 */
const CONTRAST_MARGIN = 0.03;

interface Oklch {
  L: number;
  /** Original chroma/hue (and any alpha) tokens, preserved verbatim on output. */
  rest: string[];
}

function ensureMinContrast(
  color: string,
  against: string[],
  ratio: number,
): string {
  const parsed = parseOklch(color);
  if (!parsed) return color; // not a plain oklch() value — leave it alone
  const refLums = against
    .map(relativeLuminance)
    .filter((value): value is number => value !== null);
  if (refLums.length === 0) return color;

  const target = ratio + CONTRAST_MARGIN;
  const worst = (L: number) => {
    const lum = luminanceFromLightness(L, parsed);
    return Math.min(...refLums.map((ref) => ratioFromLuminance(lum, ref)));
  };
  if (worst(parsed.L) >= target) return color; // already compliant

  // Increase contrast by moving lightness away from the reference(s). Try both
  // directions and keep whichever reaches the target with the smaller change;
  // if neither extreme reaches it (out-of-gamut edge), take the better extreme.
  const darker = solveLightness(parsed.L, 0, target, worst);
  const lighter = solveLightness(parsed.L, 1, target, worst);
  const best = pickBest(parsed.L, darker, lighter, worst, target);
  return formatOklch({ ...parsed, L: best });
}

/**
 * Binary-search the lightness between `from` and `bound` for the value closest
 * to `from` whose worst-case contrast reaches `target`. Falls back to `bound`
 * when the target is unreachable within the range.
 */
function solveLightness(
  from: number,
  bound: number,
  target: number,
  worst: (L: number) => number,
): number {
  if (worst(bound) < target) return bound;
  let lo = from;
  let hi = bound;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (worst(mid) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

function pickBest(
  from: number,
  darker: number,
  lighter: number,
  worst: (L: number) => number,
  target: number,
): number {
  const darkerOk = worst(darker) >= target;
  const lighterOk = worst(lighter) >= target;
  if (darkerOk && lighterOk) {
    return Math.abs(darker - from) <= Math.abs(lighter - from)
      ? darker
      : lighter;
  }
  if (darkerOk) return darker;
  if (lighterOk) return lighter;
  // Neither direction reaches the target — return whichever extreme is best.
  return worst(darker) >= worst(lighter) ? darker : lighter;
}

// ---- oklch <-> WCAG relative luminance ------------------------------------

function relativeLuminance(color: string): number | null {
  const parsed = parseOklch(color);
  if (!parsed) return null;
  return luminanceFromLightness(parsed.L, parsed);
}

function luminanceFromLightness(L: number, parsed: Oklch): number {
  const [C, h] = readChromaHue(parsed);
  const [r, g, b] = oklchToLinearSrgb(L, C, h);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratioFromLuminance(a: number, b: number): number {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

function readChromaHue(parsed: Oklch): [number, number] {
  const C = Number.parseFloat(parsed.rest[0] ?? "0") || 0;
  const h = Number.parseFloat(parsed.rest[1] ?? "0") || 0;
  return [C, h];
}

/** oklch → linear-light sRGB, clamped to gamut (Björn Ottosson's transform). */
function oklchToLinearSrgb(L: number, C: number, h: number): number[] {
  const hr = (h * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v)));
}

function parseOklch(value: string): Oklch | null {
  const match = value.match(/^oklch\(([^)]+)\)$/i);
  if (!match) return null;
  const tokens = match[1].trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const first = tokens[0];
  const L = first.endsWith("%")
    ? Number.parseFloat(first) / 100
    : Number.parseFloat(first);
  if (Number.isNaN(L)) return null;
  return { L, rest: tokens.slice(1) };
}

function formatOklch(parsed: Oklch): string {
  const L = formatNumber(parsed.L);
  return `oklch(${[L, ...parsed.rest].join(" ")})`;
}

function formatNumber(n: number): string {
  return Number.parseFloat(n.toFixed(4)).toString();
}
