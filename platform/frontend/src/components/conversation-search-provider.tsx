"use client";

import { useConversationSearch } from "@/lib/chat/conversation-search.hook";
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
