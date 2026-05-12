import { useEffect, useState } from "react";

/**
 * Delays turning an `enabled` flag on while still turning it off immediately.
 *
 * Useful for noncritical queries that should not compete with first-load shell
 * data, but can still run shortly after the page settles.
 */
export function useDeferredEnabled(enabled: boolean, delayMs: number) {
  const [deferredEnabled, setDeferredEnabled] = useState(
    enabled && delayMs <= 0,
  );

  useEffect(() => {
    if (!enabled) {
      setDeferredEnabled(false);
      return;
    }

    if (delayMs <= 0) {
      setDeferredEnabled(true);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setDeferredEnabled(true);
    }, delayMs);

    return () => window.clearTimeout(timeoutId);
  }, [delayMs, enabled]);

  return deferredEnabled;
}
