"use client";

import type { UIMessage } from "@ai-sdk/react";
import type { ChatStatus } from "ai";
import { useEffect, useRef, useState } from "react";

/**
 * Seconds of total stream silence — not even a backend heartbeat — before the
 * connection is treated as stalled. The backend writes a `data-heartbeat` every
 * 5s for as long as a run is open, so this is eight consecutive misses: bytes
 * have stopped arriving, which usually means an intermediary closed the stream.
 */
export const TRANSPORT_STALL_THRESHOLD_SECONDS = 40;

/**
 * Seconds without any response progress before a turn that has produced nothing
 * yet is called slow. Deliberately far above the transport threshold: an
 * agentic turn can legitimately sit quiet through a long tool call or a
 * provider queue, and warning at 40s cried wolf on runs that were fine.
 */
export const UPSTREAM_IDLE_THRESHOLD_SECONDS = 90;

interface StreamStallState {
  /** Nothing at all is arriving — the connection itself looks dead. */
  isTransportStalled: boolean;
  /** The transport is alive but the provider has not produced this turn yet. */
  isUpstreamIdle: boolean;
}

/**
 * Watches a live chat run for the two ways it can go quiet.
 *
 * `isUpstreamIdle` is deliberately gated on the turn having rendered nothing:
 * once any text, reasoning, tool call or file is on screen, a lull is not
 * something to warn about, and saying "no response progress has been received"
 * over an answer the user is already reading is simply wrong.
 *
 * That gate is also what stops the notice outliving the answer. The idle window
 * only ever closes on a new progress signal or on the run ending, and a run that
 * stays open past its visible reply produces neither: its heartbeats keep the
 * transport clock fresh but count as transport activity, not response progress.
 * Without the gate the window expires over finished content and never reopens.
 *
 * A genuinely dead connection is still reported through `isTransportStalled`
 * whether or not anything rendered.
 */
export function useStreamStall({
  status,
  transportActivitySequence,
  responseProgressSequence,
  messages,
  transportThresholdSeconds = TRANSPORT_STALL_THRESHOLD_SECONDS,
  upstreamIdleThresholdSeconds = UPSTREAM_IDLE_THRESHOLD_SECONDS,
}: {
  status: ChatStatus;
  /** Monotonic signal advanced by every event received from the stream. */
  transportActivitySequence: number;
  /** Monotonic signal advanced only when the assistant response progresses. */
  responseProgressSequence: number;
  messages: UIMessage[];
  transportThresholdSeconds?: number;
  upstreamIdleThresholdSeconds?: number;
}): StreamStallState {
  const isTransportStalled = useActivityIdle({
    status,
    activitySequence: transportActivitySequence,
    thresholdSeconds: transportThresholdSeconds,
  });
  const isResponseProgressIdle = useActivityIdle({
    status,
    activitySequence: responseProgressSequence,
    thresholdSeconds: upstreamIdleThresholdSeconds,
  });

  return {
    isTransportStalled,
    isUpstreamIdle:
      !isTransportStalled &&
      isResponseProgressIdle &&
      !hasRenderedAssistantOutput(messages),
  };
}

// ===========================================================================
// Internal
// ===========================================================================

function useActivityIdle({
  status,
  activitySequence,
  thresholdSeconds,
}: {
  status: ChatStatus;
  activitySequence: number;
  thresholdSeconds: number;
}) {
  const [isIdle, setIsIdle] = useState(false);
  const latestActivitySequence = useRef(activitySequence);

  useEffect(() => {
    latestActivitySequence.current = activitySequence;

    if (status !== "submitted" && status !== "streaming") {
      setIsIdle(false);
      return;
    }

    setIsIdle(false);
    const observedActivitySequence = activitySequence;
    const timeout = setTimeout(() => {
      // Cleanup normally prevents stale timers, while this guard also covers a
      // timer firing in the same task as a newly committed activity signal.
      if (latestActivitySequence.current === observedActivitySequence) {
        setIsIdle(true);
      }
    }, thresholdSeconds * 1000);

    return () => clearTimeout(timeout);
  }, [status, activitySequence, thresholdSeconds]);

  return isIdle;
}

/**
 * Whether the assistant turn in flight has put anything on screen yet. Only the
 * trailing message matters: an earlier turn's answer says nothing about whether
 * the current one has started.
 */
function hasRenderedAssistantOutput(messages: UIMessage[]): boolean {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== "assistant") {
    return false;
  }

  return lastMessage.parts.some((part) => {
    if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
      return true;
    }
    if (part.type === "text" || part.type === "reasoning") {
      return part.text.trim().length > 0;
    }
    return part.type === "file";
  });
}
