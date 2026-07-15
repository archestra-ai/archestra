"use client";

import { useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Wraps a settings card so links elsewhere in the app can deep-link to it
 * with `?highlight=<id>`: the card scrolls into view and its border flashes
 * red a few times (see .settings-highlight-flash in globals.css).
 */
export function HighlightAnchor({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const searchParams = useSearchParams();
  const isTarget = searchParams.get("highlight") === id;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!isTarget || !el) return;
    // Sections above the card can still be streaming in and shift layout
    // after the first scroll, so keep re-scrolling for a moment until the
    // card actually sits in view. Instant (not smooth) scrolling: smooth
    // scrollIntoView silently no-ops inside the app's nested scroll layout.
    const scrollIntoViewIfNeeded = () => {
      const rect = el.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > window.innerHeight) {
        el.scrollIntoView({ block: "center" });
      }
    };
    scrollIntoViewIfNeeded();
    const interval = setInterval(scrollIntoViewIfNeeded, 400);
    const stop = setTimeout(() => clearInterval(interval), 2000);
    return () => {
      clearInterval(interval);
      clearTimeout(stop);
    };
  }, [isTarget]);

  return (
    <div
      id={id}
      ref={ref}
      // rounded-xl matches Card so the flashing ring follows its corners.
      className={cn(
        "scroll-mt-24 rounded-xl",
        isTarget && "settings-highlight-flash",
      )}
    >
      {children}
    </div>
  );
}
