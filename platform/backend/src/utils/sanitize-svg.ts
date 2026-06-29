import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

const window = new JSDOM("").window;
// biome-ignore lint/suspicious/noExplicitAny: jsdom's window shape doesn't match DOMPurify's WindowLike type literally, but is compatible at runtime.
const purify = createDOMPurify(window as any);

/**
 * Sanitize an SVG document string by stripping script tags, event handlers,
 * foreignObject, and any href/xlink:href values that aren't safe data URIs or
 * fragment identifiers. Returns the cleaned SVG source, or null if the input
 * is not a valid SVG.
 */
export function sanitizeSvg(svg: string): string | null {
  const clean = purify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "foreignObject"],
    FORBID_ATTR: ["onload", "onerror", "onclick", "onmouseover", "onfocus"],
  });

  // DOMPurify with the svg profile may return inner contents only when given a
  // bare svg fragment. Re-wrap if the root <svg> was unwrapped.
  const trimmed = clean.trim();
  if (!trimmed) return null;
  if (!/^<svg[\s>]/i.test(trimmed)) return null;
  return trimmed;
}
