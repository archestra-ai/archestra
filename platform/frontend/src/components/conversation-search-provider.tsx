"use client";

import { useEffect, useState } from "react";
import { appInteractive } from "@/lib/app-interactive";
import { useConversationSearch } from "@/lib/chat/conversation-search.hook";
import { lazyComponent } from "@/lib/utils/preloadable-lazy";

const ConversationSearchPalette = lazyComponent(() =>
  import("./conversation-search-palette").then(
    (m) => m.ConversationSearchPalette,
  ),
);

/**
 * The conversation search palette. Its shortcuts (Cmd/Ctrl+K and the new-chat
 * keys) are registered at once by useConversationSearch; the palette itself
 * mounts on its first open or the first idle callback after the app is
 * interactive, whichever comes first — a shortcut pressed before then opens it
 * as soon as its chunk arrives.
 */
export function ConversationSearchProvider() {
  const { isOpen, setIsOpen } = useConversationSearch();
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void appInteractive.whenIdle().then(() => {
      if (!cancelled) setIdle(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isOpen && !idle) return null;
  return <ConversationSearchPalette open={isOpen} onOpenChange={setIsOpen} />;
}
