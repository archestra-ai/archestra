"use client";

import React from "react";
import { cn } from "@/lib/utils";

/** How long the fade/scale-out plays before the dot unmounts (ms). */
const EXIT_MS = 260;

/**
 * A small, subtle onboarding nudge dot.
 *
 * Drive it with `visible` (defaults to `true`) rather than conditionally
 * rendering it, so it can play a gentle exit animation before unmounting —
 * e.g. when the user visits the item and its dot clears. It stays mounted
 * through the fade/scale-out, then removes itself.
 */
export function OnboardingDot({
  visible = true,
  className,
}: {
  visible?: boolean;
  className?: string;
}) {
  // Keep the dot mounted while it animates out; drop it once EXIT_MS elapses.
  const [mounted, setMounted] = React.useState(visible);

  React.useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [visible]);

  if (!mounted) return null;

  return (
    <span
      aria-hidden
      data-testid="onboarding-dot"
      data-state={visible ? "visible" : "leaving"}
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full bg-red-500/80",
        // Soft halo so it reads as a gentle nudge rather than a hard alert.
        "shadow-[0_0_5px_1px] shadow-red-500/30",
        // Gentle enter/exit. fill-mode-forwards holds the faded-out end state
        // during the brief window before the unmount timer fires.
        "duration-300 ease-out",
        visible
          ? "animate-in fade-in-0 zoom-in-50"
          : "animate-out fade-out-0 zoom-out-75 fill-mode-forwards",
        className,
      )}
    />
  );
}
