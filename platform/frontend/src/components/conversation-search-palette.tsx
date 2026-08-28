"use client";
import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import { useDebounce } from "@uidotdev/usehooks";
import { Folder, MessageCircle, Pencil, Pin, UsersRound } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  chatsNavItems,
  contentNavGroups,
  isNavItemPermitted,
} from "@/app/_parts/studio-nav";
import { AgentIcon } from "@/components/agent-icon";
import { LockedChatIcon } from "@/components/chat/locked-chat-icon";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  NEW_LOCKED_CHAT_HREF,
  SHORTCUT_DELETE,
  SHORTCUT_NEW_CHAT,
  SHORTCUT_NEW_LOCKED_CHAT,
  SHORTCUT_PIN,
  SHORTCUT_SEARCH,
  SHORTCUT_SIDEBAR,
} from "@/consts";
import { useIsAuthenticated } from "@/lib/auth/auth.hook";
import { useHasPermissions, usePermissionMap } from "@/lib/auth/auth.query";
import {
  useConversations,
  useDeleteConversation,
  usePinConversation,
} from "@/lib/chat/chat.query";
import {
  getConversationDisplayTitle,
  getConversationShareTooltip,
} from "@/lib/chat/chat-utils";
import { getDateBucketLabel } from "@/lib/chat/group-conversations-by-date";
import { useFeature } from "@/lib/config/config.query";
import { usePlatform } from "@/lib/hooks/use-platform";

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

/**
 * Search synonyms, for words a reader might type that the destination's own
 * name does not contain. Keyed by URL so a rename cannot strand them, and
 * optional: a page without an entry is still found by its name.
 */
const NAVIGATION_KEYWORDS: Record<string, string> = {
  "/agents": "agent bot ai a2a api invocation",
  "/skills": "skills abilities",
  "/plugins": "plugins extensions",
  "/settings/messaging-channels":
    "messaging channels triggers automation webhooks slack ms teams email",
  "/mcp/registry": "mcp catalog registry servers",
  "/mcp/gateways": "gateways security mcp",
  "/mcp/tool-guardrails": "tools guardrails policies permissions security",
  "/llm/proxy": "proxy llm network",
  "/llm/proxy/virtual-keys": "virtual keys credentials",
  "/llm/model-providers": "provider api keys models llm",
  "/llm/models": "models catalog",
  "/llm/costs": "usage cost dashboard limits budget spend",
  "/knowledge/connectors": "knowledge connectors sources sync",
  "/knowledge/files": "knowledge files documents uploads",
  "/knowledge/knowledge-bases": "knowledge bases embeddings retrieval rag",
  "/llm/logs": "logs llm proxy requests",
  "/settings": "settings configuration preferences",
  "/connection": "connect integration api",
  "/projects": "projects workspaces",
  "/apps": "apps",
};

/**
 * The destinations this palette can jump to, taken from the same definition
 * the sidebar renders and filtered by the same permission rule — so a page
 * the reader may not open is not offered here, and a page named or moved in
 * one surface cannot go stale in the other.
 */
function useNavigationDestinations() {
  const permissionMap = usePermissionMap(requiredPagePermissionsMap);
  const pluginsEnabled = useFeature("plugins");
  // Connect needs both halves of what it explains, exactly as the sidebar
  // gates its own row.
  const { data: canReadLlmProxy } = useHasPermissions({ llmProxy: ["read"] });
  const { data: canReadMcpGateway } = useHasPermissions({
    mcpGateway: ["read"],
  });

  return useMemo(() => {
    if (!permissionMap) return [];
    const items = [
      // New Chat is the palette's own first row, so listing it again here
      // would offer the same destination twice.
      ...chatsNavItems.filter((item) => item.url !== "/chat"),
      ...contentNavGroups.flatMap((group) => group.items),
    ];
    return items
      .filter((item) => {
        if (item.url === "/connection") {
          return canReadLlmProxy === true && canReadMcpGateway === true;
        }
        if (item.url === "/plugins") return pluginsEnabled === true;
        return isNavItemPermitted(item, permissionMap);
      })
      .map((item) => ({
        icon: item.icon,
        label: item.tooltipLabel ?? item.title,
        value: item.url,
        keywords: NAVIGATION_KEYWORDS[item.url] ?? "",
        href: item.url,
      }));
  }, [permissionMap, pluginsEnabled, canReadLlmProxy, canReadMcpGateway]);
}

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
  const pathname = usePathname();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedValue, setSelectedValue] = useState("");
  const [isPendingDeletion, setIsPendingDeletion] = useState<string | null>(
    null,
  );
  const isAuthenticated = useIsAuthenticated();
  const { data: canReadConversation } = useHasPermissions({
    chat: ["read"],
  });
  const { modKey, altKey } = usePlatform();
  const lockedChatEnabled = useFeature("lockedChatEnabled") ?? false;

  const deleteMutation = useDeleteConversation();
  const pinMutation = usePinConversation();

  // Track in-flight deletions via ref to prevent rapid double-deletion
  // (React batches state updates, so the keydown handler may see stale state)
  const deletingIdsRef = useRef(new Set<string>());

  // Debounce search query to reduce API calls while typing
  const debouncedSearch = useDebounce(searchQuery, 300);

  // Fetch conversations with backend search
  const {
    data: conversations = [],
    isLoading,
    isFetching,
  } = useConversations({
    enabled: open && isAuthenticated && canReadConversation === true,
    search: debouncedSearch,
  });

  const navigationDestinations = useNavigationDestinations();

  // Show skeleton during typing or initial fetch
  const isSearching = searchQuery.trim().length > 0;
  const isTyping = searchQuery !== debouncedSearch;
  const isSearchingAndFetching = isSearching && (isTyping || isFetching);

  const matchingNavigationItems = useMemo(() => {
    if (recentChatsView) return [];

    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    if (!normalizedQuery) return navigationDestinations;

    return navigationDestinations.filter((item) =>
      `${item.label} ${item.value} ${item.keywords}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }, [recentChatsView, searchQuery, navigationDestinations]);

  const browseConversations = useMemo(() => {
    if (debouncedSearch.trim()) {
      return null;
    }
    return {
      pinned: conversations.filter((c) => c.pinnedAt),
      unpinned: conversations.filter((c) => !c.pinnedAt),
    };
  }, [conversations, debouncedSearch]);

  // Reset state on every open/close transition.
  // Clearing on open handles stale chars from macOS dead keys (e.g. Option+N inserts ˜
  // via a composition event AFTER the dialog closes, bypassing the close cleanup).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reacting to open changes to reset all dialog state
  useEffect(() => {
    setSearchQuery("");
    setSelectedValue("");
    setIsPendingDeletion(null);
    deletingIdsRef.current.clear();
  }, [open]);

  // Reset pending deletion when selection or search query changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reacting to selectedValue/searchQuery changes to clear stale deletion state
  useEffect(() => {
    setIsPendingDeletion(null);
  }, [selectedValue, searchQuery]);

  // Search replaces and filters the item set. With a controlled value, cmdk
  // only auto-selects the first item when the value is falsy — a stale
  // selection leaves the fresh list with no selected option, so ArrowUp and
  // Enter dead-end (WCAG 2.1.1). Clear it as soon as the query changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reacting to searchQuery changes to reset the selection
  useEffect(() => {
    setSelectedValue("");
  }, [searchQuery]);

  const handleSelectConversation = (conversationId: string) => {
    router.push(`/chat/${conversationId}`);
    onOpenChange(false);
  };

  const handleNewChat = useCallback(() => {
    router.push("/chat");
    onOpenChange(false);
  }, [router, onOpenChange]);

  const handleNewLockedChat = useCallback(() => {
    router.push(NEW_LOCKED_CHAT_HREF);
    onOpenChange(false);
  }, [router, onOpenChange]);

  const handleDeleteConversation = useCallback(
    (conversationId: string) => {
      // Guard against rapid double-deletion (ref is synchronous, not batched)
      if (deletingIdsRef.current.has(conversationId)) return;
      deletingIdsRef.current.add(conversationId);

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
      deleteMutation.mutate(conversationId, {
        onSettled: () => deletingIdsRef.current.delete(conversationId),
      });
      setIsPendingDeletion(null);

      // Redirect to new chat if the deleted conversation is currently open
      if (pathname === `/chat/${conversationId}`) {
        router.push("/chat");
      }
    },
    [deleteMutation, conversations, pathname, router],
  );

  const handlePinConversation = useCallback(
    (conversationId: string) => {
      const conv = conversations.find((c) => c.id === conversationId);
      if (!conv) return;
      pinMutation.mutate({ id: conversationId, pinned: !conv.pinnedAt });
    },
    [pinMutation, conversations],
  );

  // Keyboard shortcuts for search palette
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Alt-qualified shortcuts (WCAG 2.1.4 forbids bare character keys) that
      // also work while a search query is being typed. Matching on e.code
      // sidesteps macOS Option dead-key characters, like SHORTCUT_NEW_CHAT.
      if (!e.altKey || e.metaKey || e.ctrlKey) return;

      // Alt+D deletes the selected conversation (press twice to confirm)
      if (
        e.code === SHORTCUT_DELETE.code &&
        selectedValue?.startsWith("conv-")
      ) {
        e.preventDefault();
        e.stopPropagation();
        const conversationId = selectedValue.substring(5);

        if (isPendingDeletion === conversationId) {
          handleDeleteConversation(conversationId);
        } else {
          setIsPendingDeletion(conversationId);
        }
      }

      // Alt+P pins/unpins the selected conversation
      if (e.code === SHORTCUT_PIN.code && selectedValue?.startsWith("conv-")) {
        e.preventDefault();
        e.stopPropagation();
        const conversationId = selectedValue.substring(5);
        handlePinConversation(conversationId);
      }

      // Alt+I starts a new locked chat (mirrors the global shortcut, so it
      // also works with the palette open).
      if (lockedChatEnabled && e.code === SHORTCUT_NEW_LOCKED_CHAT.code) {
        e.preventDefault();
        e.stopPropagation();
        handleNewLockedChat();
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [
    open,
    selectedValue,
    isPendingDeletion,
    handleDeleteConversation,
    handlePinConversation,
    lockedChatEnabled,
    handleNewLockedChat,
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

  const renderConversationItem = (
    conv: (typeof conversations)[number],
    opts?: { showPinIcon?: boolean; dateLabel?: string },
  ) => {
    const { showPinIcon = false, dateLabel } = opts ?? {};
    const isSearchActive = debouncedSearch.trim().length > 0;
    const displayTitle = getConversationDisplayTitle(conv.title, conv.messages);
    const preview = isSearchActive
      ? getPreviewText(conv.messages, debouncedSearch)
      : "";
    const isPending = isPendingDeletion === conv.id;
    const IconComponent = showPinIcon ? Pin : MessageCircle;

    return (
      <CommandItem
        key={conv.id}
        value={`conv-${conv.id}`}
        onSelect={() => handleSelectConversation(conv.id)}
        className="flex flex-col items-start gap-1.5 px-3 py-2.5 cursor-pointer aria-selected:bg-accent rounded-sm w-full relative"
      >
        <div className="flex items-start gap-2 w-full min-w-0">
          <IconComponent className="h-4 w-4 shrink-0 text-muted-foreground" />
          {conv.lockedChat && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <LockedChatIcon className="mt-0.5 h-3.5 w-3.5" />
                </TooltipTrigger>
                <TooltipContent side="top">Locked chat</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {conv.share && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <UsersRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/80" />
                </TooltipTrigger>
                <TooltipContent side="top">
                  {getConversationShareTooltip(conv.share.visibility)}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <span className="text-sm flex-1 min-w-0 break-words leading-snug line-clamp-2">
            {displayTitle}
          </span>
          {conv.projectName && (
            <span className="mt-0.5 flex max-w-24 shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
              {conv.projectIcon ? (
                <AgentIcon
                  icon={conv.projectIcon}
                  fallbackType="project"
                  size={10}
                />
              ) : (
                <Folder className="h-2.5 w-2.5 shrink-0" />
              )}
              <span className="truncate">{conv.projectName}</span>
            </span>
          )}
          {dateLabel && !isPending && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {dateLabel}
            </span>
          )}
          {isPending && (
            <Badge
              variant="destructive"
              className="absolute right-3 top-2.5 text-[10px] shadow-sm animate-in fade-in zoom-in duration-200"
            >
              Press "{altKey} {SHORTCUT_DELETE.label}" to confirm
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

  const renderNavigationItems = () =>
    matchingNavigationItems.map((item) => {
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
          <span className="text-sm font-medium">{item.label}</span>
        </CommandItem>
      );
    });

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search or navigate"
      description="Search chats and navigate to pages"
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
      {/* Persistent live region: mounting the visual confirm badge together
          with its text is not reliably announced, so the delete-confirmation
          prompt is mirrored here (WCAG 4.1.3). */}
      <output aria-live="polite" className="sr-only">
        {isPendingDeletion && (
          <span>
            Press {altKey} {SHORTCUT_DELETE.label} again to confirm deleting the
            selected conversation.
          </span>
        )}
      </output>
      <CommandList className="max-h-[500px]">
        {isLoading && !isSearching ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Loading conversations...
          </div>
        ) : isSearching ? (
          <>
            {matchingNavigationItems.length > 0 && (
              <CommandGroup heading="Pages">
                {renderNavigationItems()}
              </CommandGroup>
            )}

            {isSearchingAndFetching ? (
              <CommandGroup heading="Chats">
                <SearchSkeleton />
              </CommandGroup>
            ) : conversations.length > 0 ? (
              <CommandGroup heading="Chats">
                {conversations.map((conv) => renderConversationItem(conv))}
              </CommandGroup>
            ) : matchingNavigationItems.length === 0 ? (
              <CommandEmpty>
                {recentChatsView
                  ? "No conversations found."
                  : "No chats or pages found."}
              </CommandEmpty>
            ) : null}
          </>
        ) : (
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
              {lockedChatEnabled && (
                <CommandItem
                  value="new-locked-chat private locked"
                  onSelect={handleNewLockedChat}
                  className="flex items-center gap-2 px-3 py-2.5 cursor-pointer aria-selected:bg-accent"
                >
                  <LockedChatIcon className="h-4 w-4 shrink-0" />
                  <span className="font-medium">New locked chat</span>
                </CommandItem>
              )}
            </CommandGroup>

            {/* Only when there is something under it. A reader who has never
                started a chat was shown the heading over empty space, between
                the New chat row and Pages. */}
            {!recentChatsView && conversations.length > 0 && (
              <>
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

            {browseConversations ? (
              <>
                {browseConversations.pinned.length > 0 && (
                  <CommandGroup heading="Pinned">
                    {browseConversations.pinned.map((conv) =>
                      renderConversationItem(conv, {
                        showPinIcon: true,
                        dateLabel: getDateBucketLabel(conv.lastMessageAt),
                      }),
                    )}
                  </CommandGroup>
                )}
                {browseConversations.unpinned.length > 0 && (
                  <CommandGroup>
                    {browseConversations.unpinned.map((conv) =>
                      renderConversationItem(conv, {
                        dateLabel: getDateBucketLabel(conv.lastMessageAt),
                      }),
                    )}
                  </CommandGroup>
                )}
                {recentChatsView && conversations.length === 0 && (
                  <div className="py-4 text-center text-sm text-muted-foreground">
                    No recent chats
                  </div>
                )}
              </>
            ) : null}

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
                <CommandGroup>{renderNavigationItems()}</CommandGroup>
              </>
            )}
          </>
        )}
      </CommandList>

      <div className="border-t bg-muted/30 px-4 py-2.5">
        {/* Two aligned rows rather than one: the single row overflowed the
            dialog once there were this many shortcuts. The grid keeps each
            column lined up between the rows. */}
        <div className="grid grid-cols-3 gap-x-3 gap-y-1.5">
          <FooterShortcut
            keys={[modKey, SHORTCUT_SEARCH.label]}
            label="Search"
          />
          <FooterShortcut
            keys={[altKey, SHORTCUT_NEW_CHAT.label]}
            label="New Chat"
          />
          {lockedChatEnabled && (
            <FooterShortcut
              keys={[altKey, SHORTCUT_NEW_LOCKED_CHAT.label]}
              label="New Locked Chat"
            />
          )}
          <FooterShortcut
            keys={[altKey, SHORTCUT_PIN.label]}
            label="Pin / Unpin Chat"
          />
          <FooterShortcut
            keys={[altKey, SHORTCUT_DELETE.label]}
            label="Delete Chat"
          />
          <FooterShortcut
            keys={[modKey, SHORTCUT_SIDEBAR.label]}
            label="Sidebar"
          />
        </div>
      </div>
    </CommandDialog>
  );
}

/** One footer hint: its key caps followed by the action label. */
function FooterShortcut({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex min-w-0 items-center justify-center gap-1.5">
      <span className="flex shrink-0 items-center gap-1">
        {keys.map((key) => (
          <kbd
            key={key}
            className="inline-flex h-4 min-w-[18px] items-center justify-center rounded border border-border/50 bg-muted px-1 font-sans text-[9px] font-medium text-muted-foreground"
          >
            {key}
          </kbd>
        ))}
      </span>
      <span className="truncate text-[11px] text-muted-foreground">
        {label}
      </span>
    </div>
  );
}
