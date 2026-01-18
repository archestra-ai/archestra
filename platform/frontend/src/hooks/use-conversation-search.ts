"use client";

import { useEffect, useState } from "react";

export function useConversationSearch() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const handleOpenPalette = () => setIsOpen(true);

    const handleKeyDown = (event: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const isModKey = isMac ? event.metaKey : event.ctrlKey;

      // Cmd/Ctrl+K should work even when focused on input elements
      // This is standard behavior for "quick open" shortcuts (VS Code, Slack, etc.)
      if (isModKey && event.key === "k" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        setIsOpen((prev) => !prev);
      }
    };

    window.addEventListener("open-conversation-search", handleOpenPalette);
    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("open-conversation-search", handleOpenPalette);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);

  return {
    isOpen,
    setIsOpen,
  };
}
