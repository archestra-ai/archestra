"use client";

import { useEffect, useState } from "react";

/**
 * Hook that returns whether the current page is visible to the user
 * Uses the Page Visibility API to detect when the tab is active/inactive
 */
export function usePageVisibility(): boolean {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsVisible(!document.hidden);
    };

    // Set initial state
    setIsVisible(!document.hidden);

    // Listen for visibility changes
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return isVisible;
}

/**
 * Hook that provides smart polling intervals based on page visibility
 * Returns a polling interval that adjusts based on whether the page is visible
 */
export function useSmartPolling({
  activeInterval = 10_000,
  inactiveInterval = 30_000,
}: {
  activeInterval?: number;
  inactiveInterval?: number;
} = {}): number {
  const isVisible = usePageVisibility();

  // Use shorter interval when page is visible, longer when inactive
  return isVisible ? activeInterval : inactiveInterval;
}
