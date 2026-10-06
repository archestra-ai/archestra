import type { Locator, Page } from "@playwright/test";
import type { SeedState } from "./seed";

/**
 * One docs screenshot. Captured twice, light and dark, into
 * `docs/assets/<asset>.webp` and `docs/assets/<asset>.dark.webp`.
 */
export interface Shot {
  /** Path under docs/assets without the extension, as the markdown embeds it. */
  asset: string;
  /** Frontend route to open; ids come from the seed state. */
  route: (seed: SeedState) => string;
  /** UI steps after the page settles: open a dialog, switch a tab, hover. */
  prepare?: (page: Page, seed: SeedState) => Promise<void>;
  /** The element to capture; defaults to the whole viewport. */
  target?: (page: Page) => Locator;
  viewport?: { width: number; height: number };
}
