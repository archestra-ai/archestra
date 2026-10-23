"use client";

import type { KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { copyToClipboard } from "@/lib/clipboard";
import { SHORT_HASH_LENGTH } from "./refs";

/**
 * The version history's keys, read like a pager over `git log`: `j`/`k` move
 * to the older/newer version (`j` past the oldest loaded one pulls the next
 * page), `g` jumps to HEAD, `d` flips Changes/All, `y` copies the selected
 * version's hash and `r` asks to restore it. Esc is the dialog's own.
 *
 * Returns the handler for the dialog surface plus a short-lived status notice
 * ("copied 3f9a2c1") for the status line to show.
 *
 * Keys are ignored while the reader is typing — an input, a textarea, or a
 * Monaco editor (whose input is a textarea) — and whenever `enabled` is off,
 * which the dialogs hold while a confirmation is open over them. A keystroke
 * from inside a portal (the confirmation itself, a tooltip) still bubbles
 * through the React tree to this handler, so anything outside the surface's
 * own DOM is ignored too. An action a key cannot take right now is left out
 * rather than passed as a no-op, so the key does nothing at all.
 */
export function useVersionHistoryShortcuts({
  enabled,
  versions,
  activeVersion,
  headVersion,
  onSelectVersion,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onToggleViewMode,
  hash,
  onRestore,
}: {
  enabled: boolean;
  /** Version numbers in rail order, newest first. */
  versions: number[];
  activeVersion: number | null;
  headVersion: number | null;
  onSelectVersion: (version: number) => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onToggleViewMode?: () => void;
  /** The selected version's content hash, when there is one to copy. */
  hash: string | null;
  onRestore?: () => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const flash = (message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!enabled || event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof Element) || !event.currentTarget.contains(target)) {
      return;
    }
    if (target.closest(TYPING_TARGETS)) return;

    switch (event.key) {
      case "j": {
        const older = nearest(versions, activeVersion, "older");
        if (older !== null) {
          onSelectVersion(older);
        } else if (hasMore && !isLoadingMore) {
          onLoadMore();
        }
        break;
      }
      case "k": {
        const newer = nearest(versions, activeVersion, "newer");
        if (newer !== null) onSelectVersion(newer);
        break;
      }
      case "g":
        if (headVersion !== null) onSelectVersion(headVersion);
        break;
      case "d":
        if (!onToggleViewMode) return;
        onToggleViewMode();
        break;
      case "y": {
        if (!hash) return;
        const short = hash.slice(0, SHORT_HASH_LENGTH);
        copyToClipboard(hash).then(
          () => flash(`copied ${short}`),
          () => flash("could not copy the hash"),
        );
        break;
      }
      case "r":
        if (!onRestore) return;
        onRestore();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return { onKeyDown, notice };
}

// ============================================================================
// Internal helpers
// ============================================================================

const NOTICE_MS = 1600;

/** Where a keystroke is text, not a command. */
const TYPING_TARGETS =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], .monaco-editor";

/**
 * The closest listed version older or newer than `active`. By number rather
 * than by position: the selection can be a version the list does not hold
 * yet — the head a restore just minted, before the refetch lists it.
 */
function nearest(
  versions: number[],
  active: number | null,
  direction: "older" | "newer",
): number | null {
  if (active === null) return versions[0] ?? null;
  let best: number | null = null;
  for (const version of versions) {
    if (direction === "older" && version < active) {
      if (best === null || version > best) best = version;
    }
    if (direction === "newer" && version > active) {
      if (best === null || version < best) best = version;
    }
  }
  return best;
}
