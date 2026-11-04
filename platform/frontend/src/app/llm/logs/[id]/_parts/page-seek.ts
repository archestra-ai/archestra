"use client";

import { useEffect, useState } from "react";

/**
 * Moves the session's pages to the one that holds a linked record. A count
 * gives the first page to try; from there each landed page says whether the
 * record lies before it, after it, or on it (or nowhere). A count alone can
 * miss: requests that share a moment, or that overlap the record, sort
 * differently from how pages own it. The walk never revisits a page, so it
 * settles within the session's page count.
 */
export function usePageSeek({
  id,
  ready,
  pageIndex,
  lastPageIndex,
  guess,
  here,
  onLocatePage,
}: {
  /** The record being sought, once known to belong to this session. */
  id: string | null;
  /** Whether this page's rows are the settled answer for `pageIndex`. */
  ready: boolean;
  pageIndex: number;
  lastPageIndex: number;
  /** The first page to try, when counted; undefined while counting. */
  guess: number | undefined;
  /**
   * Where the record lies from this page: -1 before it, 1 after it, 0 on it
   * or nowhere nearer. Undefined until this page can tell.
   */
  here: -1 | 0 | 1 | undefined;
  onLocatePage: (pageIndex: number) => void;
}): {
  /** The walk ended on this page: the record is here, or nowhere. */
  settled: boolean;
} {
  const [seek, setSeek] = useState<Seek | null>(null);
  const mine = seek !== null && seek.id === id ? seek : null;

  useEffect(() => {
    if (id === null || !ready || here === undefined) return;
    if (mine?.endedAt != null) return;
    // Waiting for the move to land.
    if (mine && mine.pending !== pageIndex) return;
    if (here === 0) {
      setSeek({ id, visited: [], pending: null, endedAt: pageIndex });
      return;
    }
    if (!mine) {
      if (guess === undefined) return;
      const first = Math.min(lastPageIndex, Math.max(0, guess));
      if (first !== pageIndex) {
        setSeek({ id, visited: [pageIndex], pending: first, endedAt: null });
        onLocatePage(first);
        return;
      }
    }
    const visited = mine?.visited ?? [];
    const next = pageIndex + here;
    if (next < 0 || next > lastPageIndex || visited.includes(next)) {
      setSeek({ id, visited, pending: null, endedAt: pageIndex });
      return;
    }
    setSeek({
      id,
      visited: [...visited, pageIndex],
      pending: next,
      endedAt: null,
    });
    onLocatePage(next);
  }, [id, ready, here, mine, pageIndex, guess, lastPageIndex, onLocatePage]);

  return { settled: ready && mine?.endedAt === pageIndex };
}

// ============================================================================
// Internal helpers
// ============================================================================

type Seek = {
  id: string;
  /** Pages already landed on, oldest first. */
  visited: number[];
  /** The page a move is on its way to. */
  pending: number | null;
  /** The page the walk ended on. */
  endedAt: number | null;
};
