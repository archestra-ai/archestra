"use client";

import { useDebounce } from "@uidotdev/usehooks";
import { isToday, isWithinInterval, isYesterday, subDays } from "date-fns";
import { MessageSquare, Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useIsAuthenticated } from "@/lib/auth.hook";
import { useConversations } from "@/lib/chat.query";
import { getConversationDisplayTitle } from "@/lib/chat-utils";

/**
 * Extracts all text content from messages for preview purposes.
 * Includes all messages (user + AI) to provide search context.
 */
function extractTextFromMessages(
  // biome-ignore lint/suspicious/noExplicitAny: UIMessage structure from AI SDK is dynamic
  messages?: any[],
): string {
  if (!messages || messages.length === 0) return "";

  const textParts: string[] = [];
  for (const msg of messages) {
    if (msg.parts && Array.isArray(msg.parts)) {
      for (const part of msg.parts) {
        if (part.type === "text" && part.text) {
          textParts.push(part.text);
        }
      }
    }
  }
  return textParts.join(" ");
}

/** Groups conversations into time-based buckets for organized display */
function groupConversationsByDate<T extends { updatedAt: string | Date }>(
  conversations: T[],
) {
  const today: T[] = [];
  const yesterday: T[] = [];
  const previous7Days: T[] = [];
  const older: T[] = [];

  const now = new Date();
  const sevenDaysAgo = subDays(now, 7);

  for (const conv of conversations) {
    const updatedAt = new Date(conv.updatedAt);
    if (isToday(updatedAt)) {
      today.push(conv);
    } else if (isYesterday(updatedAt)) {
      yesterday.push(conv);
    } else if (isWithinInterval(updatedAt, { start: sevenDaysAgo, end: now })) {
      previous7Days.push(conv);
    } else {
      older.push(conv);
    }
  }

  return { today, yesterday, previous7Days, older };
}

interface ConversationSearchPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConversationSearchPalette({
  open,
  onOpenChange,
}: ConversationSearchPaletteProps) {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const isAuthenticated = useIsAuthenticated();

  // Debounce search query to reduce API calls while typing
  const debouncedSearch = useDebounce(searchQuery, 300);

  // Fetch conversations with backend search
  const {
    data: conversations = [],
    isLoading,
    isFetching,
  } = useConversations({
    enabled: isAuthenticated,
    search: debouncedSearch,
  });

  // Show skeleton during typing or initial fetch
  const isSearching = searchQuery.trim().length > 0;
  const isTyping = searchQuery !== debouncedSearch;
  const isSearchingAndFetching = isSearching && (isTyping || isFetching);

  const groupedConversations = useMemo(() => {
    if (debouncedSearch.trim()) {
      return null;
    }
    return groupConversationsByDate(conversations);
  }, [conversations, debouncedSearch]);

  useEffect(() => {
    if (!open) {
      setSearchQuery("");
    }
  }, [open]);

  const handleSelectConversation = (conversationId: string) => {
    router.push(`/chat?conversation=${conversationId}`);
    onOpenChange(false);
  };

  const handleNewChat = () => {
    router.push("/chat");
    onOpenChange(false);
  };

  /** Generates a contextual preview snippet with search term context */
  const getPreviewText = (
    // biome-ignore lint/suspicious/noExplicitAny: UIMessage structure from AI SDK is dynamic
    messages?: any[],
    query?: string,
  ): string => {
    const content = extractTextFromMessages(messages);
    if (!content) return "";

    if (query?.trim()) {
      const queryLower = query.toLowerCase();
      const contentLower = content.toLowerCase();
      const matchIndex = contentLower.indexOf(queryLower);

      if (matchIndex !== -1) {
        const start = Math.max(0, matchIndex - 50);
        const end = Math.min(content.length, matchIndex + query.length + 100);
        let snippet = content.slice(start, end);
        if (start > 0) snippet = `...${snippet}`;
        if (end < content.length) snippet = `${snippet}...`;
        return snippet;
      }
    }

    if (content.length <= 150) return content;
    return `${content.slice(0, 150)}...`;
  };

  /** Wraps search term matches in <span> elements for visual highlighting */
  const highlightMatch = (text: string, query: string): React.ReactNode => {
    if (!query.trim()) return text;

    const parts: React.ReactNode[] = [];
    const regex = new RegExp(
      `(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
      "gi",
    );
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    // biome-ignore lint/suspicious/noAssignInExpressions: Standard regex exec pattern
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index));
      }
      parts.push(
        <span key={match.index} className="font-semibold">
          {match[0]}
        </span>,
      );
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex));
    }

    return parts.length > 0 ? parts : text;
  };

  // Loading skeleton for search results
  const SKELETON_IDS = [1, 2, 3, 4, 5];
  const SearchSkeleton = () => (
    <div className="py-2 px-3 space-y-3">
      {SKELETON_IDS.map((id) => (
        <div key={id} className="flex items-start gap-2 py-2">
          <div className="h-4 w-4 bg-muted rounded animate-pulse" />
          <div className="flex-1 space-y-2">
            <div className="h-4 bg-muted rounded w-3/4 animate-pulse" />
            <div className="h-3 bg-muted rounded w-full animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );

  const renderConversationItem = (conv: (typeof conversations)[number]) => {
    const isSearchActive = debouncedSearch.trim().length > 0;
    const displayTitle = getConversationDisplayTitle(conv.title, conv.messages);
    const preview = isSearchActive
      ? getPreviewText(conv.messages, debouncedSearch)
      : "";

    return (
      <CommandItem
        key={conv.id}
        value={conv.id}
        onSelect={() => handleSelectConversation(conv.id)}
        className="flex flex-col items-start gap-1.5 px-3 py-2.5 cursor-pointer aria-selected:bg-accent rounded-sm w-full"
      >
        <div className="flex items-start gap-2 w-full min-w-0">
          <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm flex-1 min-w-0 break-words leading-snug line-clamp-2">
            {displayTitle}
          </span>
        </div>
        {isSearchActive && preview && (
          <div className="text-xs text-muted-foreground line-clamp-2 w-full pl-6">
            {highlightMatch(preview, debouncedSearch)}
          </div>
        )}
      </CommandItem>
    );
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search conversations"
      description="Search through your conversation history"
      className="max-w-2xl"
      shouldFilter={false}
    >
      <CommandInput
        placeholder="Search chats..."
        value={searchQuery}
        onValueChange={setSearchQuery}
      />
      <CommandList className="max-h-[500px]">
        {isLoading && !isSearching ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Loading conversations...
          </div>
        ) : isSearchingAndFetching ? (
          <SearchSkeleton />
        ) : (
          <>
            {!searchQuery.trim() && (
              <CommandGroup>
                <CommandItem
                  value="new-chat"
                  onSelect={handleNewChat}
                  className="flex items-center gap-2 px-3 py-3 cursor-pointer aria-selected:bg-accent"
                >
                  <Pencil className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="font-medium">Start a New Chat</span>
                </CommandItem>
              </CommandGroup>
            )}

            {debouncedSearch.trim() ? (
              conversations.length === 0 ? (
                <CommandEmpty>No conversations found.</CommandEmpty>
              ) : (
                <CommandGroup heading="Search Results">
                  {conversations.map((conv) => renderConversationItem(conv))}
                </CommandGroup>
              )
            ) : groupedConversations ? (
              <>
                {groupedConversations.today.length > 0 && (
                  <CommandGroup heading="Today">
                    {groupedConversations.today.map((conv) =>
                      renderConversationItem(conv),
                    )}
                  </CommandGroup>
                )}
                {groupedConversations.yesterday.length > 0 && (
                  <CommandGroup heading="Yesterday">
                    {groupedConversations.yesterday.map((conv) =>
                      renderConversationItem(conv),
                    )}
                  </CommandGroup>
                )}
                {groupedConversations.previous7Days.length > 0 && (
                  <CommandGroup heading="Previous 7 Days">
                    {groupedConversations.previous7Days.map((conv) =>
                      renderConversationItem(conv),
                    )}
                  </CommandGroup>
                )}
                {groupedConversations.older.length > 0 && (
                  <CommandGroup heading="Previous 30 Days">
                    {groupedConversations.older.map((conv) =>
                      renderConversationItem(conv),
                    )}
                  </CommandGroup>
                )}
                {conversations.length === 0 && (
                  <CommandEmpty>No conversations yet.</CommandEmpty>
                )}
              </>
            ) : null}
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
