"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Visually-hidden polite live region that announces coarse chat stream state to
 * screen-reader users (WCAG 4.1.3 Status Messages). Streaming the assistant's
 * tokens through a live region would be far too chatty, so this announces only
 * the transitions a non-sighted user needs: that the assistant started
 * responding, finished, or errored. Renders nothing visible and has no layout
 * footprint, so it is safe to drop anywhere in the chat tree.
 */
export function ChatStatusAnnouncer({ status }: { status: string }) {
  const [message, setMessage] = useState("");
  const previousStatus = useRef(status);

  useEffect(() => {
    const previous = previousStatus.current;
    previousStatus.current = status;

    const wasResponding = previous === "submitted" || previous === "streaming";
    const isResponding = status === "submitted" || status === "streaming";

    if (isResponding && !wasResponding) {
      setMessage("Assistant is responding");
    } else if (status === "ready" && wasResponding) {
      setMessage("Assistant response ready");
    } else if (status === "error" && previous !== "error") {
      setMessage("Assistant response failed");
    }
  }, [status]);

  return (
    // <output> carries an implicit role="status" polite live region.
    <output aria-live="polite" className="sr-only">
      {message}
    </output>
  );
}
