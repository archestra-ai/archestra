"use client";

import { useEffect, useState } from "react";
import { LoadingState } from "@/components/loading";

/**
 * Loader for the browser panel while the first screenshot is on its way.
 *
 * Connecting can take several seconds, and nothing reports progress until the
 * first frame arrives, so the messages advance on a timer. They follow the
 * real order of the backend's subscribe flow (session, tab, URL restore,
 * screenshot) but only describe work, never claim a step finished, so running
 * ahead of the backend stays truthful. The last message holds until the
 * screenshot replaces the loader.
 */
export function BrowserConnectingState() {
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    if (messageIndex >= CONNECTING_MESSAGES.length - 1) return;
    const timeout = setTimeout(
      () => setMessageIndex((index) => index + 1),
      MESSAGE_INTERVAL_MS,
    );
    return () => clearTimeout(timeout);
  }, [messageIndex]);

  return (
    <div className="flex flex-col items-center gap-2 px-6">
      <LoadingState
        variant="compact"
        label="Connecting to the browser"
        showLabel={false}
      />
      {/* Screen readers get the stable label above; re-announcing a new line every few seconds is noise. */}
      <p
        key={messageIndex}
        aria-hidden="true"
        className="animate-in fade-in-0 slide-in-from-bottom-1 duration-300 text-sm font-medium text-foreground text-center motion-reduce:animate-none"
      >
        {CONNECTING_MESSAGES[messageIndex]}
      </p>
      <p aria-hidden="true" className="text-xs text-muted-foreground">
        The first connection takes a few seconds
      </p>
    </div>
  );
}

const MESSAGE_INTERVAL_MS = 2200;

const CONNECTING_MESSAGES = [
  "Connecting to the browser…",
  "Opening an isolated browser session…",
  "Finding your tab…",
  "Loading the last page you had open…",
  "Capturing the first frame…",
  "Still working…",
];
