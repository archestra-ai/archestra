"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  NEW_INCOGNITO_CHAT_HREF,
  SHORTCUT_NEW_CHAT,
  SHORTCUT_NEW_INCOGNITO_CHAT,
  SHORTCUT_SEARCH,
} from "@/consts";
import { useFeature } from "@/lib/config/config.query";
import { usePlatform } from "@/lib/hooks/use-platform";

export function useConversationSearch() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [recentChatsView, setRecentChatsView] = useState(false);
  const { isMac } = usePlatform();
  const incognitoEnabled = useFeature("chatIncognitoEnabled") ?? false;

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

      // Alt + I: New Incognito Chat. Same Alt-qualified shape as Alt+N, and
      // inert while the instance has incognito chats disabled.
      if (
        incognitoEnabled &&
        event.altKey &&
        event.code === SHORTCUT_NEW_INCOGNITO_CHAT.code
      ) {
        event.preventDefault();
        event.stopPropagation();
        setIsOpen(false);
        router.push(NEW_INCOGNITO_CHAT_HREF);
      }
    };

    window.addEventListener("open-conversation-search", handleOpenPalette);
    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("open-conversation-search", handleOpenPalette);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [router, isMac, incognitoEnabled]);

  return {
    isOpen,
    setIsOpen,
    recentChatsView,
  };
}
