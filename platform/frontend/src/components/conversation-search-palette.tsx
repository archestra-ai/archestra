"use client";

import { useDebounce } from "@uidotdev/usehooks";
import { isToday, isWithinInterval, isYesterday, subDays } from "date-fns";
import {
  Bot,
  Cable,
  Home,
  Key,
  MessageCircle,
  MessagesSquare,
  Network,
  Pencil,
  Router,
  Settings,
  Shield,
  Wrench,
  Zap,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { usePlatform } from "@/hooks/use-platform";
import { useIsAuthenticated } from "@/lib/auth.hook";
import { useConversations, useDeleteConversation } from "@/lib/chat.query";
import { getConversationDisplayTitle } from "@/lib/chat-utils";
import {
  SHORTCUT_DELETE,
  SHORTCUT_NEW_CHAT,
  SHORTCUT_SEARCH,
  SHORTCUT_SIDEBAR,
} from "@/lib/keyboard-shortcuts";

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

// Product navigation items matching sidebar names
const navigationItems = [
  {
    icon: Bot,
    label: "Agents",
    value: "agents",
    keywords: "agent bot ai",
    href: "/agents",
  },
  {
    icon: Zap,
    label: "Agent Triggers",
    value: "agent-triggers",
    keywords: "triggers automation webhooks ms teams",
    href: "/agent-triggers/ms-teams",
  },
  {
    icon: Shield,
    label: "MCP Gateways",
    value: "mcp-gateways",
    keywords: "gateways security mcp",
    href: "/mcp-gateways",
  },
  {
    icon: Network,
    label: "LLM Proxies",
    value: "llm-proxies",
    keywords: "proxies llm network",
    href: "/llm-proxies",
  },
  {
    icon: Key,
    label: "Provider Settings",
    value: "provider-settings",
    keywords: "provider settings api keys virtual keys models llm",
    href: "/llm-proxies/provider-settings",
  },
  {
    icon: MessagesSquare,
    label: "Logs",
    value: "logs",
    keywords: "logs llm proxy requests",
    href: "/logs/llm-proxy",
  },
  {
    icon: Wrench,
    label: "Tool Policies",
    value: "tool-policies",
    keywords: "tools policies permissions",
    href: "/tool-policies",
  },
  {
    icon: Router,
    label: "MCP Registry",
    value: "mcp-registry",
    keywords: "mcp catalog registry servers",
    href: "/mcp-catalog/registry",
  },
  {
    icon: Home,
    label: "Cost & Limits",
    value: "cost-limits",
    keywords: "cost dashboard limits budget",
    href: "/cost",
  },
  {
    icon: Cable,
    label: "Connect",
    value: "connect",
    keywords: "connect integration api",
    href: "/connection",
  },
  {
    icon: Settings,
    label: "Settings",
    value: "settings",
    keywords: "settings configuration preferences",
    href: "/settings",
  },
];

interface ConversationSearchPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recentChatsView?: boolean;
}

export function ConversationSearchPalette({
  open,
  onOpenChange,
  recentChatsView = false,
}: ConversationSearchPaletteProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedValue, setSelectedValue] = useState("");
  const [isPendingDeletion, setIsPendingDeletion] = useState<string | null>(
    null,
  );
  const isAuthenticated = useIsAuthenticated();
  const { modKey, altKey } = usePlatform();

  const deleteMutation = useDeleteConversation();

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

  // Reset state on every open/close transition.
  // Clearing on open handles stale chars from macOS dead keys (e.g. Option+N inserts ˜
  // via a composition event AFTER the dialog closes, bypassing the close cleanup).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reacting to open changes to reset all dialog state
  useEffect(() => {
    setSearchQuery("");
    setSelectedValue("");
    setIsPendingDeletion(null);
  }, [open]);

  // Reset pending deletion when selection or search query changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reacting to selectedValue/searchQuery changes to clear stale deletion state
  useEffect(() => {
    setIsPendingDeletion(null);
  }, [selectedValue, searchQuery]);

  const handleSelectConversation = (conversationId: string) => {
    router.push(`/chat?conversation=${conversationId}`);
    onOpenChange(false);
  };

  const handleNewChat = useCallback(() => {
    router.push("/chat");
    onOpenChange(false);
  }, [router, onOpenChange]);

  const handleDeleteConversation = useCallback(
    (conversationId: string) => {
      // Find the next conversation to select after deletion
      const currentIndex = conversations.findIndex(
        (c) => c.id === conversationId,
      );
      if (currentIndex !== -1) {
        const nextConv =
          conversations[currentIndex - 1] ??
          conversations[currentIndex + 1] ??
          null;
        setSelectedValue(nextConv ? `conv-${nextConv.id}` : "");
      }
      deleteMutation.mutate(conversationId);
      setIsPendingDeletion(null);

      // Redirect to new chat if the deleted conversation is currently open
      if (searchParams.get("conversation") === conversationId) {
        router.push("/chat");
      }
    },
    [deleteMutation, conversations, searchParams, router],
  );

  // Keyboard shortcuts for search palette
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // In cmdk, the input always retains focus even during arrow-key navigation.
      // Only intercept 'd' when the search input is empty (browse mode).
      // When the user is typing a search query, let 'd' pass through normally.
      if (searchQuery) return;

      // 'd' for delete when conversation is selected
      if (e.key === SHORTCUT_DELETE.key && selectedValue?.startsWith("conv-")) {
        e.preventDefault();
        e.stopPropagation();
        const conversationId = selectedValue.substring(5);

        if (isPendingDeletion === conversationId) {
          handleDeleteConversation(conversationId);
        } else {
          setIsPendingDeletion(conversationId);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [
    open,
    selectedValue,
    searchQuery,
    isPendingDeletion,
    handleDeleteConversation,
  ]);

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
    const isPending = isPendingDeletion === conv.id;

    return (
      <CommandItem
        key={conv.id}
        value={`conv-${conv.id}`}
        onSelect={() => handleSelectConversation(conv.id)}
        className="flex flex-col items-start gap-1.5 px-3 py-2.5 cursor-pointer aria-selected:bg-accent rounded-sm w-full relative"
      >
        <div className="flex items-start gap-2 w-full min-w-0">
          <MessageCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm flex-1 min-w-0 break-words leading-snug line-clamp-2">
            {displayTitle}
          </span>
          {isPending && (
            <Badge
              variant="destructive"
              className="absolute right-3 top-2.5 text-[10px] shadow-sm animate-in fade-in zoom-in duration-200"
            >
              Press "{SHORTCUT_DELETE.label}" to confirm
            </Badge>
          )}
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
      value={selectedValue}
      onValueChange={setSelectedValue}
    >
      <CommandInput
        placeholder="Search or navigate..."
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
              <>
                <CommandGroup>
                  <CommandItem
                    value="new-chat"
                    onSelect={handleNewChat}
                    className="flex items-center gap-2 px-3 py-2.5 cursor-pointer aria-selected:bg-accent"
                  >
                    <Pencil className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="font-medium">New chat</span>
                  </CommandItem>
                </CommandGroup>

                {!recentChatsView && (
                  <>
                    <CommandSeparator className="my-2" />

                    <div className="px-2 pb-1.5">
                      <div className="flex items-center justify-between px-1">
                        <span className="text-xs font-medium text-muted-foreground">
                          Pages
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Jump to
                        </span>
                      </div>
                    </div>
                    <CommandGroup>
                      {navigationItems.map((item) => {
                        const Icon = item.icon;
                        return (
                          <CommandItem
                            key={item.value}
                            value={`${item.value} ${item.keywords} ${item.label}`}
                            onSelect={() => {
                              router.push(item.href);
                              onOpenChange(false);
                            }}
                            className="flex items-center gap-3 px-3 py-2.5 cursor-pointer aria-selected:bg-accent rounded-sm"
                          >
                            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="text-sm font-medium">
                              {item.label}
                            </span>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>

                    <CommandSeparator className="my-2" />

                    <div className="px-2 pb-1.5">
                      <div className="flex items-center justify-between px-1">
                        <span className="text-xs font-medium text-muted-foreground">
                          Chats
                        </span>
                      </div>
                    </div>
                  </>
                )}
              </>
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
                  <div className="py-4 text-center text-sm text-muted-foreground">
                    No recent chats
                  </div>
                )}
              </>
            ) : null}
          </>
        )}
      </CommandList>

      <div className="border-t bg-muted/30 px-4 py-3">
        <div className="flex items-center justify-center gap-6 flex-wrap text-xs">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded bg-muted px-1.5 font-sans text-[10px] font-medium text-muted-foreground border border-border/50">
                {modKey}
              </kbd>
              <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded bg-muted px-1.5 font-sans text-[10px] font-medium text-muted-foreground border border-border/50">
                {SHORTCUT_SEARCH.label}
              </kbd>
            </div>
            <span className="text-muted-foreground/70">Search</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded bg-muted px-1.5 font-sans text-[10px] font-medium text-muted-foreground border border-border/50">
                {altKey}
              </kbd>
              <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded bg-muted px-1.5 font-sans text-[10px] font-medium text-muted-foreground border border-border/50">
                {SHORTCUT_NEW_CHAT.label}
              </kbd>
            </div>
            <span className="text-muted-foreground/70">New Chat</span>
          </div>
          <div className="flex items-center gap-2">
            <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded bg-muted px-1.5 font-sans text-[10px] font-medium text-muted-foreground border border-border/50">
              {SHORTCUT_DELETE.label}
            </kbd>
            <span className="text-muted-foreground/70">Delete Chat</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded bg-muted px-1.5 font-sans text-[10px] font-medium text-muted-foreground border border-border/50">
                {modKey}
              </kbd>
              <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded bg-muted px-1.5 font-sans text-[10px] font-medium text-muted-foreground border border-border/50">
                {SHORTCUT_SIDEBAR.label}
              </kbd>
            </div>
            <span className="text-muted-foreground/70">Sidebar</span>
          </div>
        </div>
      </div>
    </CommandDialog>
  );
}
