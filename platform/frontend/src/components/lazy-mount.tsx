"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * Mounts its children the first time they scroll into view, holding their
 * eventual height in reserve so nothing below them jumps when they land.
 *
 * Not worth the indirection for content that is cheap to render. It is here
 * for Monaco: an editor builds its own DOM tree and text models on mount, and
 * a pane that stacks one per section otherwise pays for every section the
 * reader never scrolls to.
 *
 * Where there is no `IntersectionObserver` — jsdom, and anything old enough to
 * lack it — the children mount immediately. Degrading to the eager render
 * costs performance; degrading to a blank box would cost the content.
 */
export function LazyMount({
  height,
  children,
}: {
  /** Height in px to hold while the children are still unmounted. */
  height: number;
  children: ReactNode;
}) {
  // Starts false even without an observer, so the server and the first client
  // render agree; the effect below is what mounts eagerly.
  const [isMounted, setIsMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (isMounted || !element) return;
    if (typeof IntersectionObserver === "undefined") {
      setIsMounted(true);
      return;
    }
    // Deliberately no `rootMargin`: an ancestor's overflow clip is applied
    // before the root's margin is, so a lead time measured against the
    // viewport buys nothing for children of a scroll pane — which is where
    // this is used. Mounting a little early would take passing that pane as
    // `root`, and a callback ref to reach it; not worth the parts unless the
    // reserved-height box is ever seen empty.
    const observer = new IntersectionObserver((entries) => {
      // Mounted is a one-way door: rebuilding an editor on every scroll past
      // would cost more than keeping the one that is already built.
      if (entries.some((entry) => entry.isIntersecting)) setIsMounted(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [isMounted]);

  return (
    <div ref={ref} style={isMounted ? undefined : { minHeight: height }}>
      {isMounted ? children : null}
    </div>
  );
}
