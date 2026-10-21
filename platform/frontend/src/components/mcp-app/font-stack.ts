/**
 * Ends a theme font stack with a generic family so MCP Apps never fall back
 * to the browser's default serif. Theme stacks such as `var(--font-geist)`
 * resolve to bundled font names only, and the sandboxed app iframe cannot
 * load those font files.
 */
export function withGenericFontFallback(
  stack: string,
  generic: GenericFontFamily,
): string {
  const families = stack
    .split(",")
    .map((family) => family.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
  if (families.includes(generic)) {
    return stack;
  }
  const fallback = GENERIC_FALLBACKS[generic];
  return families.length > 0 ? `${stack}, ${fallback}` : fallback;
}

type GenericFontFamily = "sans-serif" | "monospace";

const GENERIC_FALLBACKS: Record<GenericFontFamily, string> = {
  "sans-serif": "ui-sans-serif, system-ui, sans-serif",
  monospace: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};
