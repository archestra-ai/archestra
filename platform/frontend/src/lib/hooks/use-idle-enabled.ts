import { useEffect, useState } from "react";

/**
 * `enabled`, held off until the browser is first idle after the page's first
 * content: for requests nobody is waiting on (nudges, banners, surveys) that
 * would otherwise go out with the page's own first requests and compete with
 * them. Once the page has been idle, later mounts are enabled straight away.
 */
export function useIdleEnabled(enabled: boolean): boolean {
  const [idle, setIdle] = useState(idleReached);

  useEffect(() => {
    if (idle) return;
    return whenIdle(() => {
      idleReached = true;
      setIdle(true);
    });
  }, [idle]);

  return enabled && idle;
}

// ===== Internal =====

let idleReached = false;

/** The longest a noncritical request waits for an idle moment. */
const IDLE_TIMEOUT_MS = 2_000;

function whenIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(callback, {
      timeout: IDLE_TIMEOUT_MS,
    });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(callback, 200);
  return () => window.clearTimeout(handle);
}
