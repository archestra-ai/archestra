"use client";

import type { MouseEvent, ReactNode } from "react";

/**
 * Keeps a click from reaching the row it is in. `DataTable` bubbles every cell
 * click to its `onRowClick`, so anything with a job of its own — the name
 * link, a badge's tooltip, the action buttons and the spans that carry a
 * disabled button's tooltip — is wrapped in this so activating it never also
 * opens the row's detail page.
 */
export function RowClickShield({
  children,
  className,
}: {
  children: ReactNode;
  /** `contents` keeps the wrapper out of the cell's own layout. */
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: not interactive itself; it exists to stop its children's events reaching the row
    <div
      className={className}
      onClick={(e) => e.stopPropagation()}
      // Table rows are not focusable, so no key event ever reaches this; it is
      // here because the a11y rule pairs the two handlers, and it costs
      // nothing should a row ever gain a key handler of its own.
      onKeyDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

/**
 * Opens a clickable row, but only for a plain click that asked for it. A
 * modified click is the browser's own "open elsewhere" gesture and belongs to
 * the name link inside the row, which is a real anchor; and a click that ends
 * a text selection is someone finishing a drag over the row's text, not asking
 * to navigate away from it.
 */
export function openRowOnPlainClick(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  open: () => void,
) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const selection =
    typeof window === "undefined" ? null : window.getSelection();
  if (selection && !selection.isCollapsed) return;
  open();
}
