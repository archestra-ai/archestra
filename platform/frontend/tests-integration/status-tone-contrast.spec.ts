import { STATUS_TONE } from "@/lib/design/status-tone";
// The workspace package's exports map does not publish this subpath, and its
// barrel entry reaches a JSON import that Playwright's ESM loader rejects, so
// this reads the theme list from the source file directly.
import { SUPPORTED_THEMES } from "../../shared/themes/theme-config";
import { expect, test } from "./fixtures";

/**
 * Proves the status tones are readable, and visible at all, everywhere they
 * can appear.
 *
 * "Everywhere" is larger than it looks. The theme is a persisted field with 24
 * values and each has a light and a dark palette, so a status pill has 48
 * possible sets of tokens under it, times the three surfaces it sits on. That
 * is 144 combinations per tone, which nobody checks by eye.
 *
 * This runs in a real browser against the app's own compiled stylesheet, so
 * the cascade, `@theme inline`, `color-mix()`, oklch-to-sRGB gamut mapping and
 * alpha compositing are all done by the engine that ships the pixels. The only
 * arithmetic done here is the WCAG luminance ratio and an OKLab distance, both
 * on 8-bit sRGB samples the browser rasterised. An earlier version of this
 * check re-implemented the colour half of a CSS engine offline to answer the
 * same question; the engine is right here, and it does not drift.
 *
 * Badge text is 12px (`text-xs`), below the 18.66px/14px-bold threshold for
 * WCAG's large-text allowance, so the floor is AA 4.5:1 with no exemption.
 *
 * It applies the class strings from `lib/design/status-tone.ts` to a real
 * element rather than a second copy of the colour spec, so what ships is what
 * is measured.
 */

const WCAG_AA_NORMAL_TEXT = 4.5;

/**
 * Contrast alone cannot see a badge that has gone missing: it measures text
 * against fill and never fill against surface, so a fill that is exactly its
 * own backdrop still passes while the pill is a 1px border around nothing.
 * That is not hypothetical, it is what an opaque `bg-muted` progress tone did
 * on a `--muted` surface.
 *
 * The floor is an OKLab distance rather than a contrast ratio because a tint
 * can differ from its surface in hue at nearly equal luminance and still be
 * plainly visible, which a luminance-only ratio would call a failure. 0.02 is
 * about the just-noticeable difference between two large flat patches; the
 * tightest combination that ships today measures 0.030.
 */
const MIN_FILL_DISTANCE = 0.02;

/** The three backdrops a status pill is placed on across the entity pages. */
const TONE_SURFACES = {
  // A card body, and the tables and lists inside one.
  card: [["--card", 1]],
  // The detail-page header band, which paints `bg-card/30` over the page.
  "card-header-band": [
    ["--background", 1],
    ["--card", 0.3],
  ],
  // A muted well: empty states, inset panels, hovered rows.
  muted: [["--muted", 1]],
} satisfies Record<string, [string, number][]>;

/** A colour no theme uses, so inheriting it means the utility never compiled. */
const UNPAINTED = "rgb(255, 0, 255)";

test("status tones clear WCAG AA and stay visible on all 48 palettes", async ({
  page,
}, testInfo) => {
  // Any route renders inside the root layout, which loads the compiled
  // stylesheet. The 404 route is the one that needs no entity data.
  await page.goto("/route-that-does-not-exist");

  const { unpainted, readings } = await page.evaluate(
    ({ themes, tones, surfaces, unpaintedColor }) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("No 2d canvas context in this browser");

      const host = document.createElement("div");
      host.style.color = unpaintedColor;
      const probe = document.createElement("div");
      host.appendChild(probe);
      document.body.appendChild(host);

      /** The colours one element paints, as the engine resolved them. */
      const paintedBy = (attributes: {
        className?: string;
        style?: string;
      }) => {
        probe.className = attributes.className ?? "";
        probe.setAttribute("style", attributes.style ?? "");
        const style = getComputedStyle(probe);
        return { color: style.color, fill: style.backgroundColor };
      };

      /** Stacks colours in source-over order and reads back the sRGB result. */
      const flatten = (layers: string[]) => {
        ctx.clearRect(0, 0, 1, 1);
        for (const layer of layers) {
          ctx.fillStyle = layer;
          ctx.fillRect(0, 0, 1, 1);
        }
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return `rgb(${r}, ${g}, ${b})`;
      };

      /** OKLab coordinates, converted by the browser's relative colour syntax. */
      const oklab = (color: string) => {
        probe.className = "";
        probe.setAttribute("style", `color: oklab(from ${color} l a b)`);
        const parsed = getComputedStyle(probe).color.match(/-?[\d.]+/g);
        if (!parsed) throw new Error(`Could not read OKLab of ${color}`);
        return parsed.slice(0, 3).map(Number);
      };

      const luminance = (color: string) => {
        const parsed = color.match(/\d+/g);
        if (!parsed) throw new Error(`Could not read sRGB of ${color}`);
        const [r, g, b] = parsed
          .slice(0, 3)
          .map((channel) => Number(channel) / 255)
          .map((c) =>
            c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
          );
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };

      const contrastRatio = (a: string, b: string) => {
        const [lighter, darker] = [luminance(a), luminance(b)].sort(
          (x, y) => y - x,
        );
        return (lighter + 0.05) / (darker + 0.05);
      };

      const oklabDistance = (a: string, b: string) => {
        const [al, aa, ab] = oklab(a);
        const [bl, ba, bb] = oklab(b);
        return Math.hypot(al - bl, aa - ba, ab - bb);
      };

      const previousClassName = document.documentElement.className;
      const unpainted: string[] = [];
      const readings: {
        theme: string;
        mode: string;
        tone: string;
        surface: string;
        textContrast: number;
        fillDistance: number;
      }[] = [];

      // A tone whose utilities never compiled paints nothing: the fill stays
      // transparent and the text inherits the sentinel from the host. The
      // theme tokens only exist under a theme class, so put one on first, or
      // this measures the moment before the app applied its own.
      document.documentElement.className = `theme-${themes[0]}`;
      for (const [tone, className] of Object.entries(tones)) {
        const painted = paintedBy({ className });
        if (
          painted.color === unpaintedColor ||
          painted.fill === "rgba(0, 0, 0, 0)"
        ) {
          unpainted.push(`${tone}: "${className}"`);
        }
      }

      for (const theme of themes) {
        for (const mode of ["light", "dark"]) {
          document.documentElement.className = `theme-${theme}${
            mode === "dark" ? " dark" : ""
          }`;

          for (const [surface, layers] of Object.entries(surfaces)) {
            const surfaceLayers = layers.map(
              ([token, alpha]) =>
                paintedBy({
                  style:
                    alpha === 1
                      ? `background-color: var(${token})`
                      : `background-color: color-mix(in oklab, var(${token}) ${
                          alpha * 100
                        }%, transparent)`,
                }).fill,
            );
            const surfaceColor = flatten(surfaceLayers);

            for (const [tone, className] of Object.entries(tones)) {
              const { color, fill } = paintedBy({ className });
              const behindText = flatten([...surfaceLayers, fill]);
              readings.push({
                theme,
                mode,
                tone,
                surface,
                textContrast: contrastRatio(flatten([color]), behindText),
                fillDistance: oklabDistance(behindText, surfaceColor),
              });
            }
          }
        }
      }

      document.documentElement.className = previousClassName;
      host.remove();
      return { unpainted, readings };
    },
    {
      themes: SUPPORTED_THEMES as readonly string[],
      tones: STATUS_TONE as Record<string, string>,
      surfaces: TONE_SURFACES as Record<string, [string, number][]>,
      unpaintedColor: UNPAINTED,
    },
  );

  const describe = (reading: (typeof readings)[number]) =>
    `${reading.theme} ${reading.mode} · ${reading.tone} on ${reading.surface} · text ${reading.textContrast.toFixed(2)}:1 · fill ΔE ${reading.fillDistance.toFixed(3)}`;

  // The whole matrix, worst text contrast first, so a tone or token change can
  // be judged on its headroom and not only on whether it failed.
  await testInfo.attach("status-tone-contrast", {
    contentType: "text/plain",
    body: [...readings]
      .sort((a, b) => a.textContrast - b.textContrast)
      .map(describe)
      .join("\n"),
  });

  expect(
    unpainted,
    "A tone painted nothing: its Tailwind utilities did not compile, so the classes name a colour that does not exist.",
  ).toEqual([]);

  expect(readings).toHaveLength(
    SUPPORTED_THEMES.length *
      2 *
      Object.keys(STATUS_TONE).length *
      Object.keys(TONE_SURFACES).length,
  );

  expect(
    readings.filter((r) => r.textContrast < WCAG_AA_NORMAL_TEXT).map(describe),
    `Status tone text must clear ${WCAG_AA_NORMAL_TEXT}:1. Badge text is 12px, so WCAG's large-text allowance does not apply. Fix by adjusting the tone recipe in app/globals.css.`,
  ).toEqual([]);

  expect(
    readings.filter((r) => r.fillDistance < MIN_FILL_DISTANCE).map(describe),
    `A tone's fill must stay at least ${MIN_FILL_DISTANCE} OKLab away from the surface under it, or the pill disappears into its own backdrop and only its border remains. Fix by giving the tone a hue the surface does not already have, or a stronger tint, in app/globals.css.`,
  ).toEqual([]);
});
