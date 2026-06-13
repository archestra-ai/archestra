import { useEffect, useState } from "react";

/**
 * Inline MCP App cards are capped to a fraction of the viewport height: tall
 * apps stay readable without pushing the chat off-screen, yet get far more room
 * than the legacy fixed 500px cap. Content beyond the ceiling is the app's own
 * responsibility to scroll internally (the card wrapper clips past it).
 */
export const INLINE_VIEWPORT_FRACTION = 0.6;
/** Floor for the inline ceiling on short viewports. */
export const MIN_INLINE_CEILING = 320;
/** Height an inline app paints at before its first size report. */
export const INITIAL_INLINE_HEIGHT = 320;

/** Inline visual ceiling for a given viewport height. */
export function inlineCeilingFor(viewportHeight: number): number {
  return Math.max(
    MIN_INLINE_CEILING,
    Math.round(viewportHeight * INLINE_VIEWPORT_FRACTION),
  );
}

/** Clamp an app-reported height into `[0, ceiling]`. */
export function clampInlineHeight(reported: number, ceiling: number): number {
  return Math.min(Math.max(reported, 0), ceiling);
}

/** Live inline ceiling, recomputed on viewport resize. SSR-safe. */
export function useInlineCeiling(): number {
  const [ceiling, setCeiling] = useState(() =>
    inlineCeilingFor(typeof window === "undefined" ? 0 : window.innerHeight),
  );
  useEffect(() => {
    const update = () => setCeiling(inlineCeilingFor(window.innerHeight));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return ceiling;
}
