"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { usePlatform } from "@/hooks/use-platform";
import { SHORTCUT_NEW_CHAT, SHORTCUT_SEARCH } from "@/lib/keyboard-shortcuts";

export function useConversationSearch() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [recentChatsView, setRecentChatsView] = useState(false);
  const { isMac } = usePlatform();

  useEffect(() => {
    const handleOpenPalette = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      setRecentChatsView(detail?.recentChatsView ?? false);
      setIsOpen(true);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const isModKey = isMac ? event.metaKey : event.ctrlKey;

      // Cmd/Ctrl+K should work even when focused on input elements
      // This is standard behavior for "quick open" shortcuts (VS Code, Slack, etc.)
      if (
        isModKey &&
        event.key === SHORTCUT_SEARCH.key &&
        !event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        setRecentChatsView(false);
        // Using functional update (prev => !prev) to avoid stale closure issues.
        // This ensures we always toggle relative to current state without needing
        // isOpen in the dependency array.
        setIsOpen((prev) => !prev);
      }

      // Alt + N: New Chat (avoids Cmd/Ctrl+N New Window conflict)
      // Use event.code because on macOS, Option+N is a dead key (˜) so event.key is "Dead"
      if (event.altKey && event.code === SHORTCUT_NEW_CHAT.code) {
        event.preventDefault();
        event.stopPropagation();
        setIsOpen(false);
        router.push("/chat");
      }
    };

    window.addEventListener("open-conversation-search", handleOpenPalette);
    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("open-conversation-search", handleOpenPalette);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [router, isMac]);

  return {
    isOpen,
    setIsOpen,
    recentChatsView,
  };
}
