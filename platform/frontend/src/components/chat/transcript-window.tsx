"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { Button } from "@/components/ui/button";

/**
 * How many timeline items (messages, error cards, compaction markers) a
 * transcript mounts when it opens: more than fills a tall viewport, so the
 * reader never sees the edge before the backfill below kicks in.
 */
const TRANSCRIPT_INITIAL_WINDOW = 30;
/** How many earlier items each backfill adds. */
const TRANSCRIPT_BACKFILL_STEP = 30;
/** Items mounted before a deep-linked message, so it has context above it. */
const DEEP_LINK_CONTEXT = 10;

type TimelineItem =
  | { kind: "message"; message: { id: string } }
  | { kind: string };

/**
 * The part of a long transcript that is mounted: its end. Mounting all of a
 * 400-message conversation cost about a second of main thread on open
 * (markdown parsing, stick-to-bottom's resize observation, layout), while the
 * reader sees the last screenful. Earlier items mount as the reader scrolls up
 * (TranscriptWindowEdge).
 *
 * The window's start is fixed once the transcript has items, so messages
 * arriving while it is open are appended rather than pushing the oldest
 * mounted ones out. A `#message-<id>` deep link opens the window around that
 * message and scrolls to it.
 */
export function useTranscriptWindow(items: readonly TimelineItem[]): {
  start: number;
  showEarlier: () => void;
  deepLinkedMessageId: string | null;
} {
  const [start, setStart] = useState<number | null>(null);
  const [deepLinkedMessageId, setDeepLinkedMessageId] = useState<string | null>(
    null,
  );
  const count = items.length;
  // The first message at or after the start: when earlier items are put in
  // front of the transcript (a long conversation's history arriving after
  // its end was shown), the window follows this message instead of keeping
  // its index, which would mount everything that arrived.
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const anchoredStart =
    start !== null && anchor.current
      ? indexOfMessage(items, anchor.current.id)
      : -1;
  const openingStart = Math.max(0, count - TRANSCRIPT_INITIAL_WINDOW);
  // Never fewer mounted than a transcript opens with: a short end shown
  // first fills up with the history that arrives in front of it.
  const effectiveStart = Math.min(
    anchoredStart >= 0
      ? Math.min(
          Math.max(0, anchoredStart - (anchor.current?.offset ?? 0)),
          openingStart,
        )
      : (start ?? openingStart),
    count,
  );
  if (start !== null) {
    anchor.current = anchorAt(items, effectiveStart);
  }

  // Fix the start the first time there is something to show (a deep link may
  // move it further back).
  useEffect(() => {
    if (start !== null || count === 0) return;
    const target = readDeepLinkedMessageId();
    const targetIndex = target
      ? items.findIndex(
          (item) => "message" in item && item.message.id === target,
        )
      : -1;
    if (targetIndex >= 0) {
      setDeepLinkedMessageId(target);
      const next = Math.max(
        0,
        Math.min(effectiveStart, targetIndex - DEEP_LINK_CONTEXT),
      );
      anchor.current = anchorAt(items, next);
      setStart(next);
    } else {
      anchor.current = anchorAt(items, effectiveStart);
      setStart(effectiveStart);
    }
  }, [start, count, items, effectiveStart]);

  const showEarlier = useCallback(() => {
    const next = Math.max(0, effectiveStart - TRANSCRIPT_BACKFILL_STEP);
    anchor.current = anchorAt(items, next);
    setStart(next);
  }, [effectiveStart, items]);

  return { start: effectiveStart, showEarlier, deepLinkedMessageId };
}

/**
 * The top edge of a windowed transcript. Scrolling near it mounts the
 * previous items, keeping the message the reader was looking at where it was
 * on screen. A real button does the same for keyboard and screen-reader
 * users (and states how many messages are not shown).
 *
 * Browser find (Ctrl+F) only sees mounted messages; the conversation search
 * palette searches the whole history on the server.
 */
export function TranscriptWindowEdge({
  hiddenCount,
  onShowEarlier,
  deepLinkedMessageId,
}: {
  hiddenCount: number;
  onShowEarlier: () => void;
  deepLinkedMessageId: string | null;
}) {
  const { scrollRef, stopScroll } = useStickToBottomContext();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ element: Element; top: number } | null>(null);

  useEffect(() => {
    if (!deepLinkedMessageId) return;
    stopScroll();
    document.getElementById(`message-${deepLinkedMessageId}`)?.scrollIntoView({
      block: "start",
    });
  }, [deepLinkedMessageId, stopScroll]);

  const showEarlier = useCallback(() => {
    // The first mounted item is what the reader sees at the top; remember
    // where it is so the new items above it do not push it down.
    const first = sentinelRef.current?.nextElementSibling;
    if (first) {
      anchor.current = {
        element: first,
        top: first.getBoundingClientRect().top,
      };
    }
    onShowEarlier();
  }, [onShowEarlier]);

  // Restore the anchor's position after the earlier items have mounted. The
  // browser's own scroll anchoring may already have done it, in which case
  // the correction is zero.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each backfill commit
  useLayoutEffect(() => {
    const saved = anchor.current;
    const scroller = scrollRef?.current;
    if (!saved || !scroller) return;
    anchor.current = null;
    const moved = saved.element.getBoundingClientRect().top - saved.top;
    if (moved !== 0) scroller.scrollTop += moved;
  }, [hiddenCount, scrollRef]);

  // Backfill only once the reader has scrolled up: right after opening, the
  // scroller can sit at the top for a frame before it is pinned to the
  // bottom, and that must not mount the whole history.
  const [scrolledUp, setScrolledUp] = useState(false);
  useEffect(() => {
    const root = scrollRef?.current;
    if (!root || scrolledUp || hiddenCount === 0) return;
    let last = root.scrollTop;
    const onScroll = () => {
      if (root.scrollTop < last) setScrolledUp(true);
      last = root.scrollTop;
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [scrollRef, scrolledUp, hiddenCount]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef?.current;
    if (!sentinel || !root || hiddenCount === 0 || !scrolledUp) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) showEarlier();
      },
      // Start mounting well before the reader reaches the edge.
      { root, rootMargin: "800px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hiddenCount, scrollRef, showEarlier, scrolledUp]);

  if (hiddenCount === 0) return null;
  return (
    <div ref={sentinelRef} className="flex justify-center pb-4">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
        onClick={showEarlier}
      >
        Show earlier messages ({hiddenCount} not shown)
      </Button>
    </div>
  );
}

// ===

function readDeepLinkedMessageId(): string | null {
  if (typeof window === "undefined") return null;
  const match = /^#message-(.+)$/.exec(window.location.hash);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function indexOfMessage(items: readonly TimelineItem[], id: string): number {
  return items.findIndex((item) => "message" in item && item.message.id === id);
}

function anchorAt(
  items: readonly TimelineItem[],
  start: number,
): { id: string; offset: number } | null {
  for (let index = start; index < items.length; index++) {
    const item = items[index];
    if ("message" in item)
      return { id: item.message.id, offset: index - start };
  }
  return null;
}
