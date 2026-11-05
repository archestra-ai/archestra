import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "archestra-reachability-mode";

export type ReachabilityMode = "manual" | "ngrok";

/**
 * How this instance is made reachable for inbound chatops webhooks — exposed
 * manually (helm/reverse proxy) or via the ngrok tunnel. Pure UI preference,
 * persisted per browser in localStorage.
 */
export function useReachabilityMode() {
  const [mode, setMode] = useState<ReachabilityMode>("ngrok");

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "manual" || stored === "ngrok") setMode(stored);
  }, []);

  const select = useCallback((value: ReachabilityMode) => {
    setMode(value);
    window.localStorage.setItem(STORAGE_KEY, value);
  }, []);

  return [mode, select] as const;
}
