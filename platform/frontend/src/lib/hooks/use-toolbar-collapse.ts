import * as React from "react";

// Breathing room (px) kept between the inline controls and the available space
// before collapsing, so they don't collapse the instant they'd touch.
const COLLAPSE_MARGIN = 8;
// Extra width (px) required to expand again beyond what's needed to collapse.
// This hysteresis prevents flip-flopping when the container hovers on the edge.
const EXPAND_HYSTERESIS = 40;

/**
 * Decides whether a prompt-input-style toolbar should collapse its inline
 * controls into a compact menu, based on whether they actually fit — not on a
 * fixed viewport/container breakpoint.
 *
 * It measures the inline controls' natural width (`contentRef`) plus the
 * always-present trailing controls (`trailingRef`) and compares that to the
 * available width (`availableRef`, e.g. the footer row). Because the container
 * can be squeezed by a side panel while the window stays wide, this reacts to
 * the toolbar's own box via ResizeObserver.
 *
 * The inline width is cached while expanded, so once collapsed (inline controls
 * unmounted) the decision to expand again uses the last-known requirement plus
 * a hysteresis margin, avoiding oscillation at the threshold.
 */
export function useToolbarCollapse({
  availableRef,
  contentRef,
  trailingRef,
}: {
  /** Element whose width is the space the toolbar has to work with. */
  availableRef: React.RefObject<HTMLElement | null>;
  /** Inline controls; their natural (scroll) width is what must fit. */
  contentRef: React.RefObject<HTMLElement | null>;
  /** Trailing controls (e.g. send button) always shown; width is reserved. */
  trailingRef: React.RefObject<HTMLElement | null>;
}): boolean {
  const [collapsed, setCollapsed] = React.useState(false);
  const collapsedRef = React.useRef(false);
  // Last measured natural width of the inline controls (cached while expanded).
  const requiredWidthRef = React.useRef(0);

  React.useLayoutEffect(() => {
    const available = availableRef.current;
    if (!available) {
      return;
    }

    const evaluate = () => {
      // Only the inline controls carry variable width; cache it while they are
      // mounted (expanded) so we can still decide once they're gone.
      const content = contentRef.current;
      if (content && !collapsedRef.current) {
        requiredWidthRef.current = content.scrollWidth;
      }

      const required = requiredWidthRef.current;
      if (required === 0) {
        return; // Nothing measured yet.
      }

      const trailing = trailingRef.current?.offsetWidth ?? 0;
      const needed = required + trailing;
      const availableWidth = available.clientWidth;

      const next = collapsedRef.current
        ? needed + EXPAND_HYSTERESIS > availableWidth // stay collapsed until clearly roomy
        : needed + COLLAPSE_MARGIN > availableWidth; // collapse as soon as it won't fit

      if (next !== collapsedRef.current) {
        collapsedRef.current = next;
        setCollapsed(next);
      }
    };

    evaluate();

    const observer = new ResizeObserver(evaluate);
    observer.observe(available);
    if (contentRef.current) {
      observer.observe(contentRef.current);
    }
    if (trailingRef.current) {
      observer.observe(trailingRef.current);
    }

    return () => observer.disconnect();
  }, [availableRef, contentRef, trailingRef]);

  return collapsed;
}
