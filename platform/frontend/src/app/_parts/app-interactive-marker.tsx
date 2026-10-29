"use client";

import { useEffect } from "react";
import { appInteractive } from "@/lib/app-interactive";

/**
 * Marks the app interactive from the root layout. Passive effects of the first
 * commit run after every child's, so this fires once the whole first screen —
 * on chat pages, the hydrated composer — has committed.
 */
export function AppInteractiveMarker() {
  useEffect(() => {
    appInteractive.mark();
  }, []);
  return null;
}
