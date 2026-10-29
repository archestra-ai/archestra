"use client";

import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils/tailwind";

/**
 * The shortcut as the viewer's keyboard labels it: ⌥N / ⌘K on a Mac, Alt+N /
 * Ctrl+K elsewhere. Rendered only in the browser — the server cannot know the
 * platform, and a guess would flip on hydration.
 */
export function ShortcutHint({
  modifier,
  letter,
  className,
}: {
  modifier: "mod" | "alt";
  letter: string;
  className?: string;
}) {
  const isMac = useSyncExternalStore(
    subscribeToNothing,
    () => navigator.platform.toUpperCase().includes("MAC"),
    () => null,
  );
  if (isMac === null) return null;
  const prefix =
    modifier === "mod" ? (isMac ? "⌘" : "Ctrl+") : isMac ? "⌥" : "Alt+";
  return (
    <kbd
      className={cn(
        "ml-auto shrink-0 font-sans text-[11px] tracking-wide text-muted-foreground group-data-[collapsible=icon]:hidden",
        className,
      )}
    >
      {prefix}
      {letter}
    </kbd>
  );
}

function subscribeToNothing() {
  return () => {};
}
