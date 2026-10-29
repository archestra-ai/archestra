"use client";

import { Globe } from "lucide-react";
import { useEffect, useState } from "react";

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
    <output
      aria-label="Connecting to the browser"
      className="flex flex-col items-center gap-5 px-8"
    >
      <span aria-hidden="true" className="relative block size-14 shrink-0">
        <span className="absolute inset-0 rounded-full border-2 border-muted-foreground/20" />
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-foreground motion-reduce:animate-none" />
        <Globe
          strokeWidth={1.6}
          className="absolute inset-0 m-auto size-[22px] text-foreground/80"
        />
      </span>
      <span className="flex min-h-12 flex-col items-center gap-1.5">
        {/* Screen readers get the stable label above; re-announcing a new line every few seconds is noise. */}
        <span
          key={messageIndex}
          aria-hidden="true"
          className="animate-in fade-in-0 slide-in-from-bottom-1.5 duration-300 text-[15px] font-medium text-foreground text-center motion-reduce:animate-none"
        >
          {CONNECTING_MESSAGES[messageIndex]}
        </span>
        <span
          aria-hidden="true"
          className="text-xs text-muted-foreground text-center"
        >
          The first connection takes a few seconds
        </span>
      </span>
    </output>
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
