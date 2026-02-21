"use client";

import { useConversationSearch } from "@/hooks/use-conversation-search";
import { ConversationSearchPalette } from "./conversation-search-palette";

export function ConversationSearchProvider() {
  const { isOpen, setIsOpen, recentChatsView } = useConversationSearch();

  return (
    <ConversationSearchPalette
      open={isOpen}
      onOpenChange={setIsOpen}
      recentChatsView={recentChatsView}
    />
  );
}
