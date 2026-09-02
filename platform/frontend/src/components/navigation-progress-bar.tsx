"use client";

import { useNavigationStatus } from "@/components/navigation-status-provider";

/**
 * Acknowledges a menu click in the place the user is looking.
 *
 * Until the next route mounts, the content area still shows the *previous*
 * page, and the only sign the app registered the click is the spinner in the
 * sidebar's circle toggle — fixed to the sidebar edge, away from the item just
 * clicked. On a route that has to fetch before it can render, that reads as an
 * app that ignored the click rather than one that is working.
 *
 * A sweep pinned to the top of the content area answers immediately without
 * moving anything: the outgoing page stays readable underneath, so this adds no
 * layout shift and no second full-area loader to the chain the page-level
 * indicator already owns.
 *
 * Decorative by design. `NavAwareSidebarCircleToggle` already announces this
 * exact state to assistive tech, and announcing one wait twice is worse than
 * not announcing it here at all (WCAG 4.1.3), so this is `aria-hidden`.
 */
export function NavigationProgressBar() {
  const { isNavigating } = useNavigationStatus();
  if (!isNavigating) return null;

  return (
    <div
      data-slot="navigation-progress"
      aria-hidden="true"
      /*
       * Pinned to the *bottom* edge of the header block and pushed clear of it,
       * so it rides directly above the page content: with no banners that block
       * is zero-height and the bar sits at the very top of the content area,
       * and when a connectivity or notification bar is present the sweep starts
       * below it rather than painting over its top three pixels.
       *
       * The enter delay keeps a navigation that resolves immediately from
       * registering as a flicker, matching the table's loading bar.
       */
      className="pointer-events-none absolute inset-x-0 bottom-0 z-30 h-[3px] translate-y-full overflow-hidden bg-primary/15 animate-in fade-in-0 duration-200 [animation-delay:150ms] [animation-fill-mode:backwards] motion-reduce:animate-none"
    >
      <div className="archestra-loading-sweep h-full rounded-full bg-primary" />
    </div>
  );
}
