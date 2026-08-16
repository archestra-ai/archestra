"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LOCKED_CHAT_DRAFT_SHORTCUT_EVENT,
  NEW_LOCKED_CHAT_HREF,
  SHORTCUT_NEW_CHAT,
  SHORTCUT_NEW_LOCKED_CHAT,
  SHORTCUT_SEARCH,
} from "@/consts";
import { useFeature } from "@/lib/config/config.query";
import { usePlatform } from "@/lib/hooks/use-platform";

export function useConversationSearch() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [recentChatsView, setRecentChatsView] = useState(false);
  const { isMac } = usePlatform();
  const lockedChatEnabled = useFeature("lockedChatEnabled") ?? false;

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
        suppressDeadKeyComposition();
        setIsOpen(false);
        router.push("/chat");
      }

      // Alt + I: New LockedChat Chat. Same Alt-qualified shape as Alt+N, and
      // inert while the instance has locked chats disabled.
      if (
        lockedChatEnabled &&
        event.altKey &&
        event.code === SHORTCUT_NEW_LOCKED_CHAT.code
      ) {
        event.preventDefault();
        event.stopPropagation();
        suppressDeadKeyComposition();
        setIsOpen(false);
        // Handshake with the new-chat composer: when it's on screen it
        // claims the shortcut (preventDefault on this cancelable event) and
        // toggles its draft in place; dispatchEvent returns false in that
        // case. Anywhere else, navigate to a fresh locked-chat draft.
        const unclaimed = window.dispatchEvent(
          new Event(LOCKED_CHAT_DRAFT_SHORTCUT_EVENT, { cancelable: true }),
        );
        if (unclaimed) {
          router.push(NEW_LOCKED_CHAT_HREF);
        }
      }
    };

    window.addEventListener("open-conversation-search", handleOpenPalette);
    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("open-conversation-search", handleOpenPalette);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [router, isMac, lockedChatEnabled]);

  return {
    isOpen,
    setIsOpen,
    recentChatsView,
  };
}

/**
 * On macOS, Option+N / Option+I are dead keys and Chromium starts their
 * composition even when the keydown is preventDefault'ed — so a "˜" or "ˆ"
 * would still land in whichever editable has focus (e.g. the chat textarea).
 * Blur it for the duration of the event so the composition has no target,
 * then restore focus.
 */
function suppressDeadKeyComposition() {
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    active.blur();
    setTimeout(() => {
      // No-op if navigation replaced the view and detached the element.
      active.focus();
    }, 0);
  }
}
