/** Prefer the space below the new-chat composer, shrinking the list to fit it. */
export function getChatSetupMenuPosition({
  triggerTop,
  triggerBottom,
  viewportTop,
  viewportHeight,
}: {
  triggerTop: number;
  triggerBottom: number;
  viewportTop: number;
  viewportHeight: number;
}): { side: "bottom" | "top"; maxHeight: number } {
  // Match the popover's 8px gap and 12px viewport padding, plus its border.
  const clearance = 22;
  const below = Math.max(
    0,
    viewportTop + viewportHeight - triggerBottom - clearance,
  );
  const above = Math.max(0, triggerTop - viewportTop - clearance);
  // A short list is preferable to flipping above a centered composer. Fall
  // back above when the lower space cannot hold the controls and useful rows.
  const side = below >= 240 || below >= above ? "bottom" : "top";
  return { side, maxHeight: side === "bottom" ? below : above };
}
