"use client";

import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";

/** The notice slot at the top of PageLayout's content area. */
export const PageHeaderBannerSlotContext = createContext<HTMLElement | null>(
  null,
);

/**
 * Keeps page-level notices sticky above the form, below the page header and tabs.
 * Without a layout slot (for example in a dialog), renders in place.
 */
export function PageHeaderBanner({ children }: { children: ReactNode }) {
  const slot = useContext(PageHeaderBannerSlotContext);
  if (slot) return createPortal(children, slot);
  return <>{children}</>;
}
