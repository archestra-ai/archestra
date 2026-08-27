/**
 * Id of the app shell's `<main>` element — the region to the right of the
 * sidebar that holds the page. It is the "skip to main content" target (WCAG
 * 2.4.1) and the box a fullscreen in-app surface expands to, so the shell and
 * the MCP App card read it from here instead of each spelling the literal.
 */
export const MAIN_CONTENT_ID = "main-content";

export type AppShellRegion = {
  top: number;
  left: number;
  width: number;
  height: number;
};

/**
 * The element a fullscreen in-app surface should size itself to, or null on the
 * chrome-less routes that render no shell (the standalone app runtime under
 * `/a/`, the chat browser preview, the offline recording renderer).
 */
export function findAppShellMain(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.getElementById(MAIN_CONTENT_ID);
}

/**
 * The box a fullscreen in-app surface fills: the shell's main region, so the
 * sidebar stays on screen and collapsing it stays the way to reclaim that width
 * — an app taking over the viewport used to hide the navigation with no way
 * back but leaving fullscreen. Falls back to the viewport where there is no
 * shell to sit inside, which is already the whole screen there.
 */
export function readAppShellRegion(): AppShellRegion {
  const main = findAppShellMain();
  if (!main) {
    return {
      top: 0,
      left: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }
  const rect = main.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}
