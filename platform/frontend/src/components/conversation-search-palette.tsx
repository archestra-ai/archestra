"use client";
import { useDebounce } from "@uidotdev/usehooks";
import {
  AppWindow,
  Bot,
  Boxes,
  Database,
  FolderKanban,
  type LucideIcon,
  MessageCircle,
  Pencil,
  Pin,
  Puzzle,
  Route,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  chatsNavItems,
  contentNavGroups,
  isNavItemPermitted,
} from "@/app/_parts/studio-nav";
import { useNavPermissionMap } from "@/app/_parts/use-settings-area-access";
import { useSettingsTabs } from "@/app/settings/settings-tabs";
import { EncryptedChatIcon } from "@/components/chat/encrypted-chat-icon";
import { RunStateIcon } from "@/components/chat/run-state-icon";
import { ProjectBadgeButton } from "@/components/project-badge-button";
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
  NEW_ENCRYPTED_CHAT_HREF,
  SHORTCUT_DELETE,
  SHORTCUT_NEW_CHAT,
  SHORTCUT_NEW_ENCRYPTED_CHAT,
  SHORTCUT_PIN,
  SHORTCUT_SEARCH,
  SHORTCUT_SIDEBAR,
} from "@/consts";
import { useAgentOptionsPage } from "@/lib/agent-options.query";
import { useMyAgentRuns } from "@/lib/agent-runtime.query";
import { useApps } from "@/lib/app.query";
import { useIsAuthenticated } from "@/lib/auth/auth.hook";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useConversations,
  useDeleteConversation,
  usePinConversation,
} from "@/lib/chat/chat.query";
import {
  getConversationDisplayTitle,
  getConversationShareTooltip,
} from "@/lib/chat/chat-utils";
import { conversationHref } from "@/lib/chat/conversation-href";
import { getDateBucketLabel } from "@/lib/chat/group-conversations-by-date";
import { buildPinnedSidebarItems } from "@/lib/chat/pinned-sidebar-items";
import { useFeature } from "@/lib/config/config.query";
import { useEnvironments } from "@/lib/environment.query";
import { usePlatform } from "@/lib/hooks/use-platform";
import { useKnowledgeBases } from "@/lib/knowledge/knowledge-base.query";
import { useMcpRegistryPage } from "@/lib/mcp/mcp-registry.query";
import { usePlugins } from "@/lib/plugins/plugin.query";
import { useProjects } from "@/lib/projects/projects.query";
import { useSkillsPaginated } from "@/lib/skills/skill.query";
import { useTeams } from "@/lib/teams/team.query";

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

/** A row in one of the search-only groups: a settings tab or a named entity. */
type SearchLink = {
  key: string;
  href: string;
  label: string;
  icon: LucideIcon | React.ComponentType<{ className?: string }>;
};

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
  "/openappa": "openappa guardrails v2 policy toml",
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
function useNavigationDestinations(
  permissionMap: Record<string, boolean> | null,
) {
  const openappaEnabled = useFeature("openappaEnabled");
  // Connect is useful with either half, exactly as the sidebar gates its row.
  const { data: canReadLlmProxy } = useHasPermissions({ llmProxy: ["read"] });
  const { data: canReadMcpGateway } = useHasPermissions({
    mcpGateway: ["read"],
  });

  return useMemo(() => {
    // null, not an empty list: an empty list would read as "no pages", when
    // the permissions simply have not arrived yet.
    if (!permissionMap) return null;
    const items = [
      // New Chat is the palette's own first row, so listing it again here
      // would offer the same destination twice.
      ...chatsNavItems.filter((item) => item.url !== "/chat"),
      ...contentNavGroups.flatMap((group) => group.items),
    ];
    return items
      .filter((item) => {
        if (item.url === "/connection") {
          return canReadLlmProxy === true || canReadMcpGateway === true;
        }
        if (item.url === "/openappa" && openappaEnabled !== true) return false;
        return isNavItemPermitted(item, permissionMap);
      })
      .map((item) => ({
        icon: item.icon,
        label: item.tooltipLabel ?? item.title,
        value: item.url,
        keywords: NAVIGATION_KEYWORDS[item.url] ?? "",
        href: item.url,
      }));
  }, [permissionMap, openappaEnabled, canReadLlmProxy, canReadMcpGateway]);
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
  const encryptedChatEnabled = useFeature("encryptedChatEnabled") ?? false;

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

  // Agent Runtime sessions live in the same sidebar timeline as chats,
  // so the palette lists them too. Server-side title search reaches older
  // pages without loading the entire history.
  const runtimeEnabled = useFeature("agentRuntime") === true;
  const runsEnabled =
    open && isAuthenticated && canReadConversation === true && runtimeEnabled;
  const runsQuery = useMyAgentRuns(
    runsEnabled,
    debouncedSearch.trim()
      ? { search: debouncedSearch.trim() }
      : { pinned: false },
  );
  const pinnedRunsQuery = useMyAgentRuns(
    runsEnabled && !debouncedSearch.trim(),
    { pinned: true },
  );
  const runs = useMemo(
    () => [
      ...new Map(
        [...(runsQuery.data ?? []), ...(pinnedRunsQuery.data ?? [])].map(
          (run) => [run.taskId, run],
        ),
      ).values(),
    ],
    [runsQuery.data, pinnedRunsQuery.data],
  );

  const permissionMap = useNavPermissionMap();
  const navigationDestinations = useNavigationDestinations(permissionMap);
  const isNavigationPending = navigationDestinations === null;

  // Entity groups appear only while typing, so nothing is fetched before
  // then. Each group follows the gate of the page its rows open, including
  // the Settings-area rule for pages under /settings, so the palette never
  // lists something the reader's own navigation hides.
  const canSeeSettingsArea = permissionMap?.["/settings"] === true;
  const canOpenPage = (href: string) =>
    permissionMap?.[href] === true &&
    (!href.startsWith("/settings/") || canSeeSettingsArea);
  const entitySearch = debouncedSearch.trim();
  const canSearchEntities = open && isAuthenticated && entitySearch.length > 0;
  const settingsTabs = useSettingsTabs({ enabled: open });
  const agentOptions = useAgentOptionsPage({
    // The /agents page lists internal agents only; gateways and proxies
    // have their own pages.
    filters: { agentType: "agent", searchMode: "name" },
    search: entitySearch,
    limit: ENTITY_RESULTS_LIMIT,
    enabled: canSearchEntities && canOpenPage("/agents"),
  });
  const skillsPage = useSkillsPaginated(
    {
      search: entitySearch,
      limit: ENTITY_RESULTS_LIMIT,
      offset: 0,
      includeContent: false,
    },
    {
      enabled: canSearchEntities && canOpenPage("/skills"),
      toastOnError: false,
    },
  );
  const appsPage = useApps(
    { search: entitySearch, limit: ENTITY_RESULTS_LIMIT, offset: 0 },
    {
      enabled: canSearchEntities && canOpenPage("/apps"),
      toastOnError: false,
    },
  );
  const projectsPage = useProjects({
    search: entitySearch,
    limit: ENTITY_RESULTS_LIMIT,
    offset: 0,
    enabled: canSearchEntities && canOpenPage("/projects"),
    toastOnError: false,
  });
  const { data: knowledgeBases = [] } = useKnowledgeBases({
    query: { search: entitySearch, limit: ENTITY_RESULTS_LIMIT },
    enabled: canSearchEntities && canOpenPage("/knowledge/knowledge-bases"),
  });
  const { data: teams = [] } = useTeams({
    includeRelations: false,
    name: entitySearch,
    enabled: canSearchEntities && canOpenPage("/settings/teams"),
  });
  // MCP servers are searched by the server like skills: the first name
  // matches from the registry's paged list, the built-in entry included.
  const mcpPage = useMcpRegistryPage(
    {
      search: entitySearch,
      includeBuiltIn: true,
      sortBy: "name",
      sortDirection: "asc",
      limit: ENTITY_RESULTS_LIMIT,
      offset: 0,
    },
    {
      enabled: canSearchEntities && canOpenPage("/mcp/registry"),
      placeholderScope: "search-palette",
    },
  );
  // No server-side name search for these; their pages also hold the whole
  // list and filter it in the browser.
  const { data: plugins = [] } = usePlugins(
    canSearchEntities && canOpenPage("/plugins"),
  );
  const { data: environmentList } = useEnvironments(
    canSearchEntities && canOpenPage("/settings/environments"),
  );

  // Show skeleton during typing or initial fetch
  const isSearching = searchQuery.trim().length > 0;
  const isTyping = searchQuery !== debouncedSearch;
  const isSearchingAndFetching =
    isSearching && (isTyping || isFetching || runsQuery.isLoading);
  // Until chats and permissions arrive, the browse view holds a skeleton in
  // place of its lists, so the palette opens at its final height and does not
  // swap rows in one at a time.
  const isBrowseLoading = isLoading || isNavigationPending;

  const matchingNavigationItems = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    const destinations = navigationDestinations ?? [];
    if (!normalizedQuery) return destinations;

    return destinations.filter((item) =>
      `${item.label} ${item.value} ${item.keywords}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }, [searchQuery, navigationDestinations]);

  // Server-searched rows are shown only for the current search: the skills
  // and apps hooks keep the previous search's rows as placeholder data, which
  // would list them under a query they do not match.
  const serverResults = <T,>(rows: T[] | undefined, isPlaceholder = false) =>
    entitySearch && !isPlaceholder
      ? (rows ?? []).slice(0, ENTITY_RESULTS_LIMIT)
      : [];
  const typedQuery = searchQuery.trim().toLocaleLowerCase();
  const nameMatches = <T,>(rows: T[], name: (row: T) => string) =>
    typedQuery
      ? rows
          .filter((row) => name(row).toLocaleLowerCase().includes(typedQuery))
          .slice(0, ENTITY_RESULTS_LIMIT)
      : [];

  const searchGroups: { heading: string; links: SearchLink[] }[] = [
    {
      heading: "Settings",
      // Matched on the label and on the path under /settings, so
      // "oauth-clients" finds its tab while "settings" stays on the Settings
      // page rather than pulling in every tab.
      links: (canSeeSettingsArea
        ? nameMatches(
            settingsTabs,
            (tab) => `${tab.label} ${tab.href.replace("/settings/", "")}`,
          )
        : []
      ).map((tab) => ({
        key: `settings-${tab.href}`,
        href: tab.href,
        label: tab.label,
        icon: tab.Icon,
      })),
    },
    {
      heading: "Agents",
      links: serverResults(
        agentOptions.data?.pages.flatMap((page) => page.data),
      ).map((agent) => ({
        key: `agent-${agent.id}`,
        href: `/agents/${agent.id}`,
        label: agent.name,
        icon: Bot,
      })),
    },
    {
      heading: "Skills",
      links: serverResults(
        skillsPage.data?.data,
        skillsPage.isPlaceholderData,
      ).map((skill) => ({
        key: `skill-${skill.id}`,
        href: `/skills/${skill.id}`,
        label: skill.name,
        icon: Sparkles,
      })),
    },
    {
      heading: "Apps",
      links: serverResults(appsPage.data?.data, appsPage.isPlaceholderData).map(
        (app) => ({
          key:
            app.source === "owned"
              ? `app-${app.id}`
              : `app-${app.mcpServerId}-${app.toolName}`,
          // Opens the Apps page filtered to the app, where its row offers
          // every way to open it.
          href: `/apps?search=${encodeURIComponent(app.name)}`,
          label: app.name,
          icon: AppWindow,
        }),
      ),
    },
    {
      heading: "Projects",
      links: serverResults(
        projectsPage.data?.data,
        projectsPage.isPlaceholderData,
      ).map((project) => ({
        key: `project-${project.id}`,
        href: `/projects/${project.id}`,
        label: project.name,
        icon: FolderKanban,
      })),
    },
    {
      heading: "Knowledge Bases",
      links: serverResults(knowledgeBases).map((knowledgeBase) => ({
        key: `knowledge-base-${knowledgeBase.id}`,
        // No per-base page exists; the list opens filtered to it.
        href: `/knowledge/knowledge-bases?search=${encodeURIComponent(knowledgeBase.name)}`,
        label: knowledgeBase.name,
        icon: Database,
      })),
    },
    {
      heading: "Plugins",
      links: nameMatches(plugins, (plugin) => plugin.displayName).map(
        (plugin) => ({
          key: `plugin-${plugin.id}`,
          href: `/plugins/${plugin.id}`,
          label: plugin.displayName,
          icon: Puzzle,
        }),
      ),
    },
    {
      heading: "Environments",
      links: nameMatches(
        environmentList?.environments ?? [],
        (environment) => environment.name,
      ).map((environment) => ({
        key: `environment-${environment.id}`,
        href: "/settings/environments",
        label: environment.name,
        icon: Boxes,
      })),
    },
    {
      heading: "Teams",
      links: serverResults(teams).map((team) => ({
        key: `team-${team.id}`,
        href: `/settings/teams?search=${encodeURIComponent(team.name)}`,
        label: team.name,
        icon: UsersRound,
      })),
    },
    {
      heading: "MCP Servers",
      links: serverResults(mcpPage.data?.data, mcpPage.isPlaceholderData).map(
        (item) => ({
          key: `mcp-${item.id}`,
          href: `/mcp/registry/${item.id}`,
          label: item.name,
          icon: Route,
        }),
      ),
    },
  ];
  const hasEntityMatches = searchGroups.some((group) => group.links.length > 0);

  // The server searches run titles. Filter cached pins too while their
  // independent browse feed is disabled during search.
  const matchingRuns = useMemo(() => {
    const normalizedQuery = debouncedSearch.trim().toLocaleLowerCase();
    if (!normalizedQuery) return [];
    return runs.filter((run) =>
      run.title.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [runs, debouncedSearch]);

  const browseItems = useMemo(() => {
    if (debouncedSearch.trim()) {
      return null;
    }
    return {
      // Keep the palette's Pinned group aligned with the sidebar: chats and
      // Agent Runtime runs share one newest-pin-first list.
      pinned: buildPinnedSidebarItems({
        chats: conversations,
        projects: [],
        runs,
      }),
      // Runs sort into the same timeline as chats, mirroring the
      // sidebar's merged recents list.
      recent: [
        ...conversations
          .filter((c) => !c.pinnedAt)
          .map((item) => ({
            kind: "conversation" as const,
            item,
            timestamp: item.lastMessageAt,
          })),
        ...runs
          .filter((run) => !run.pinnedAt)
          .map((item) => ({
            kind: "run" as const,
            item,
            timestamp: item.stateChangedAt ?? item.startedAt,
          })),
      ].sort(
        (left, right) =>
          new Date(right.timestamp).getTime() -
          new Date(left.timestamp).getTime(),
      ),
    };
  }, [conversations, runs, debouncedSearch]);

  // The browse view keeps recents short so pages stay in reach; older chats
  // are still found by typing.
  const visibleRecent = browseItems
    ? browseItems.recent.slice(0, RECENT_CHATS_LIMIT)
    : [];
  const hiddenRecentCount = browseItems
    ? browseItems.recent.length - visibleRecent.length
    : 0;

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

  const handleSelectConversation = (
    conversation: (typeof conversations)[number],
  ) => {
    router.push(conversationHref(conversation));
    onOpenChange(false);
  };

  const handleNewChat = useCallback(() => {
    router.push("/chat");
    onOpenChange(false);
  }, [router, onOpenChange]);

  const handleNewEncryptedChat = useCallback(() => {
    router.push(NEW_ENCRYPTED_CHAT_HREF);
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
      const deletedConversation = conversations.find(
        (conversation) => conversation.id === conversationId,
      );
      if (
        deletedConversation &&
        pathname === conversationHref(deletedConversation).split("?")[0]
      ) {
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

      // Alt+I starts a new encrypted chat (mirrors the global shortcut, so it
      // also works with the palette open).
      if (encryptedChatEnabled && e.code === SHORTCUT_NEW_ENCRYPTED_CHAT.code) {
        e.preventDefault();
        e.stopPropagation();
        handleNewEncryptedChat();
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
    encryptedChatEnabled,
    handleNewEncryptedChat,
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

  const BrowseSkeleton = () => (
    <div aria-hidden="true" className="space-y-2.5 px-3 py-3">
      {SKELETON_IDS.slice(0, 4).map((id) => (
        <div key={id} className="flex items-center gap-2 h-4">
          <div className="h-4 w-4 shrink-0 rounded bg-muted animate-pulse" />
          <div className="h-3.5 flex-1 rounded bg-muted animate-pulse" />
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
        onSelect={() => handleSelectConversation(conv)}
        className="flex flex-col items-start gap-1.5 px-3 py-2.5 cursor-pointer aria-selected:bg-accent rounded-sm w-full relative"
      >
        <div className="flex items-center gap-2 w-full min-w-0">
          {/* One leading icon per row: the lock replaces the chat/pin glyph
              for encrypted chats, at the same size and color, so the icon
              column stays aligned. */}
          {conv.encryptedChat ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <EncryptedChatIcon className="h-4 w-4 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="top">Encrypted chat</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <IconComponent className="h-4 w-4 shrink-0 text-muted-foreground" />
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
          <span className="text-sm flex-1 min-w-0 truncate leading-snug">
            {displayTitle}
          </span>
          {conv.projectId && conv.projectName && (
            <ProjectBadgeButton
              projectId={conv.projectId}
              projectName={conv.projectName}
              projectIcon={conv.projectIcon}
              onNavigate={(projectId) => {
                router.push(`/projects/${projectId}`);
                onOpenChange(false);
              }}
            />
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

  const renderRunItem = (
    run: (typeof runs)[number],
    opts?: { dateLabel?: string },
  ) => (
    <CommandItem
      key={`exec-${run.taskId}`}
      value={`exec-${run.taskId}`}
      onSelect={() => {
        router.push(`/chat/runs/${run.sessionId ?? run.taskId}`);
        onOpenChange(false);
      }}
      className="flex items-center gap-2 px-3 py-2.5 cursor-pointer aria-selected:bg-accent rounded-sm w-full"
    >
      <RunStateIcon
        state={run.state}
        attentionState={run.attentionState}
        startedAt={run.startedAt}
        endedAt={run.endedAt}
        hardDeadlineAt={run.hardDeadlineAt}
        lastModelActivityAt={run.lastModelActivityAt}
        className="size-4"
      />
      <span className="text-sm flex-1 min-w-0 truncate leading-snug">
        {run.title}
      </span>
      {run.projectId && run.projectName && (
        <ProjectBadgeButton
          projectId={run.projectId}
          projectName={run.projectName}
          projectIcon={run.projectIcon}
          onNavigate={(projectId) => {
            router.push(`/projects/${projectId}`);
            onOpenChange(false);
          }}
        />
      )}
      {opts?.dateLabel && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {opts.dateLabel}
        </span>
      )}
    </CommandItem>
  );

  const renderLinkItem = (link: SearchLink) => {
    const Icon = link.icon;
    return (
      <CommandItem
        key={link.key}
        value={link.key}
        onSelect={() => {
          router.push(link.href);
          onOpenChange(false);
        }}
        className="flex min-w-0 items-center gap-2 px-3 py-2! cursor-pointer aria-selected:bg-accent rounded-sm"
      >
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm">{link.label}</span>
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
          className="flex min-w-0 items-center gap-2 px-3 py-2! cursor-pointer aria-selected:bg-accent rounded-sm"
        >
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm">{item.label}</span>
        </CommandItem>
      );
    });

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search or navigate"
      description="Search chats, pages, and the names of your agents, apps, projects and more"
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
      <CommandList className="max-h-[min(640px,70vh)]">
        {isSearching ? (
          <>
            {matchingNavigationItems.length > 0 && (
              <CommandGroup heading="Pages">
                {renderNavigationItems()}
              </CommandGroup>
            )}

            {searchGroups.map(
              (group) =>
                group.links.length > 0 && (
                  <CommandGroup key={group.heading} heading={group.heading}>
                    {group.links.map(renderLinkItem)}
                  </CommandGroup>
                ),
            )}

            {isSearchingAndFetching ? (
              <CommandGroup heading="Chats">
                <SearchSkeleton />
              </CommandGroup>
            ) : conversations.length > 0 || matchingRuns.length > 0 ? (
              <CommandGroup heading="Chats">
                {conversations.map((conv) => renderConversationItem(conv))}
                {matchingRuns.map((run) => renderRunItem(run))}
              </CommandGroup>
            ) : matchingNavigationItems.length === 0 && !hasEntityMatches ? (
              <CommandEmpty>No results found.</CommandEmpty>
            ) : null}
          </>
        ) : (
          <>
            <CommandGroup
              className={
                encryptedChatEnabled ? GRID_GROUP_CLASS_NAME : undefined
              }
            >
              <CommandItem
                value="new-chat"
                onSelect={handleNewChat}
                className="flex items-center gap-2 px-3 py-2.5 cursor-pointer aria-selected:bg-accent"
              >
                <Pencil className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-sm font-medium">New chat</span>
              </CommandItem>
              {encryptedChatEnabled && (
                <CommandItem
                  value="new-encrypted-chat private locked"
                  onSelect={handleNewEncryptedChat}
                  className="flex items-center gap-2 px-3 py-2.5 cursor-pointer aria-selected:bg-accent"
                >
                  <EncryptedChatIcon className="h-4 w-4 shrink-0" />
                  <span className="text-sm font-medium">
                    New encrypted chat
                  </span>
                </CommandItem>
              )}
            </CommandGroup>

            {/* Only when there is something under it. A reader who has never
                started a chat was shown a separator over empty space, between
                the New chat row and Pages. The groups below carry their own
                headings (Pinned / Recent), so no standalone label here — a
                "Chats" label stacked on "Pinned" read as a double heading. */}
            {isBrowseLoading ? (
              <BrowseSkeleton />
            ) : (
              <>
                {(conversations.length > 0 || runs.length > 0) && (
                  <CommandSeparator className="my-2" />
                )}

                {browseItems ? (
                  <>
                    {browseItems.pinned.length > 0 && (
                      <CommandGroup heading="Pinned">
                        {browseItems.pinned.map((entry) =>
                          entry.type === "chat"
                            ? renderConversationItem(entry.item, {
                                showPinIcon: true,
                                dateLabel: getDateBucketLabel(
                                  entry.item.lastMessageAt,
                                ),
                              })
                            : renderRunItem(entry.item, {
                                dateLabel: getDateBucketLabel(
                                  entry.item.stateChangedAt ??
                                    entry.item.startedAt,
                                ),
                              }),
                        )}
                      </CommandGroup>
                    )}
                    {visibleRecent.length > 0 && (
                      <CommandGroup heading="Recent">
                        {visibleRecent.map((entry) =>
                          entry.kind === "conversation"
                            ? renderConversationItem(entry.item, {
                                dateLabel: getDateBucketLabel(entry.timestamp),
                              })
                            : renderRunItem(entry.item, {
                                dateLabel: getDateBucketLabel(entry.timestamp),
                              }),
                        )}
                        {hiddenRecentCount > 0 && (
                          // Indented to the title column so it reads as part of the list.
                          <p className="py-1 pl-9 text-xs text-muted-foreground">
                            Type to search older chats
                          </p>
                        )}
                      </CommandGroup>
                    )}
                  </>
                ) : null}

                <CommandSeparator className="my-2" />
                <CommandGroup heading="Pages" className={PAGES_GRID_CLASS_NAME}>
                  {renderNavigationItems()}
                </CommandGroup>
              </>
            )}
          </>
        )}
        {isSearching && runsQuery.hasNextPage && (
          <CommandGroup heading="Runs">
            <CommandItem
              value="load-more-runs"
              disabled={runsQuery.isFetchingNextPage}
              onSelect={() => void runsQuery.fetchNextPage()}
            >
              More runs
            </CommandItem>
          </CommandGroup>
        )}
        {pinnedRunsQuery.hasNextPage && !isSearching && (
          <CommandGroup heading="Pinned runs">
            <CommandItem
              value="load-more-pinned-runs"
              disabled={pinnedRunsQuery.isFetchingNextPage}
              onSelect={() => void pinnedRunsQuery.fetchNextPage()}
            >
              More pinned runs
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>

      <div className="border-t bg-muted/30 px-4 py-2.5">
        {/* Wraps instead of a fixed grid: the shortcut count changes with
            encrypted chat, and a grid left an empty cell in its last row. */}
        <div className="flex flex-wrap justify-center gap-x-5 gap-y-1.5">
          <FooterShortcut
            keys={[modKey, SHORTCUT_SEARCH.label]}
            label="Search"
          />
          <FooterShortcut
            keys={[altKey, SHORTCUT_NEW_CHAT.label]}
            label="New Chat"
          />
          {encryptedChatEnabled && (
            <FooterShortcut
              keys={[altKey, SHORTCUT_NEW_ENCRYPTED_CHAT.label]}
              label="New Encrypted Chat"
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

/** Recent chats shown before a search; older ones are found by typing. */
const RECENT_CHATS_LIMIT = 5;

/** Rows per entity group; a longer list pushes the chat matches out of view. */
const ENTITY_RESULTS_LIMIT = 5;

// cmdk moves the selection in DOM order, so a grid of items keeps arrow-key
// navigation reaching every option while using the dialog's width.
const GRID_GROUP_CLASS_NAME =
  "[&_[cmdk-group-items]]:grid [&_[cmdk-group-items]]:grid-cols-2 [&_[cmdk-group-items]]:gap-1";
const PAGES_GRID_CLASS_NAME =
  "[&_[cmdk-group-items]]:grid [&_[cmdk-group-items]]:grid-cols-2 sm:[&_[cmdk-group-items]]:grid-cols-3 [&_[cmdk-group-items]]:gap-x-1";
