"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Whether a side panel is open, remembered across visits; open by default.
 * A null key remembers nothing.
 */
export function useStoredFlag(key: string | null) {
  const [value, setValue] = useState(true);
  useEffect(() => {
    if (!key) return;
    try {
      if (window.localStorage.getItem(key) === "0") setValue(false);
    } catch {
      // Storage is unavailable: the default stands.
    }
  }, [key]);
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      if (!key) return;
      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // Storage is unavailable: the choice lasts for this visit.
      }
    },
    [key],
  );
  return [value, set] as const;
}
