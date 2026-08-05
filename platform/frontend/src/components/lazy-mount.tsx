"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * Mounts its children the first time they scroll near the viewport, holding
 * their eventual height in reserve so nothing below them jumps when they land.
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
    const observer = new IntersectionObserver(
      (entries) => {
        // Mounted is a one-way door: rebuilding an editor on every scroll past
        // would cost more than keeping the one that is already built.
        if (entries.some((entry) => entry.isIntersecting)) setIsMounted(true);
      },
      // Start building a little before the reader arrives.
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [isMounted]);

  return (
    <div ref={ref} style={isMounted ? undefined : { minHeight: height }}>
      {isMounted ? children : null}
    </div>
  );
}
