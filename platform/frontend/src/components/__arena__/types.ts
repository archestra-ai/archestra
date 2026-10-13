import type { ReactNode } from "react";

export type FooterVariantProps = {
  /** Secondary actions (Back / Cancel / step nav). May be empty. */
  left: ReactNode[];
  /** Primary action group (Save / Create / Next). Usually one node. */
  right: ReactNode[];
  /** Caller overrides, e.g. "sm:justify-end" or "border-t-0 sm:justify-end". */
  className?: string;
  /**
   * Spread onto exactly one element: the app's version line portals into it
   * as `<div class="text-xs text-muted-foreground" title="…">…</div>`. Style
   * that child with descendant selectors (e.g. `[&>div]:font-mono`).
   */
  slotProps: Record<string, string>;
};

/**
 * The bar's outer shell as shipped today: sticks to the window bottom on sm+,
 * the negative margin takes back the page's bottom padding.
 */
export const FOOTER_SHELL =
  "border-t bg-background sm:sticky sm:bottom-0 sm:z-10 sm:-mb-6";

/** Button-group normalisation used today (full-width stacked on phones). */
export const BUTTON_GROUP =
  "[&>button]:w-full [&>div]:w-full [&>div]:flex-col [&>div>button]:w-full sm:[&>button]:w-auto sm:[&>div]:w-auto sm:[&>div]:flex-row sm:[&>div>button]:w-auto";
