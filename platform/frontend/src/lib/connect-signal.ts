import { useEffect, useRef } from "react";

// One browser-wide signal: a tab that approves an agent connection tells any
// open Connect page in the same browser profile and origin. There is no
// payload to match, so any approval while a page waits counts.
const CHANNEL = "connect-signal";

/** Tell other tabs in this browser that an agent connection was approved. */
export function postConnected() {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(CHANNEL);
    // Delivered even though the channel closes, or the page navigates, next.
    channel.postMessage({ type: "connected" });
    channel.close();
  } catch {
    // Best effort: the Connect page also offers "Done?".
  }
}

/** Calls onConnected for each "connected" broadcast while enabled. */
export function useConnectedSignal(enabled: boolean, onConnected: () => void) {
  const latest = useRef(onConnected);
  latest.current = onConnected;
  useEffect(() => {
    if (!enabled || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      if (event.data?.type === "connected") latest.current();
    };
    return () => channel.close();
  }, [enabled]);
}
