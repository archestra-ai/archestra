"use client";

import { useCallback } from "react";

/** Patch bookmarkable selections without navigating or remounting the flow. */
export function useUpdateUrlParams() {
  return useCallback((updates: Record<string, string | null>) => {
    // Read the live URL so consecutive updates cannot overwrite each other.
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(updates)) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    // Next integrates native history updates with useSearchParams.
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, []);
}
