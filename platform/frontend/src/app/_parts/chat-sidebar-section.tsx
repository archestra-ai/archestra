"use client";

import {
  getChatItemGeneratingIndicatorTestId,
  getChatItemUnreadIndicatorTestId,
} from "@archestra/shared";
import {
  AppWindow,
  Folder,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Sparkles,
  Trash2,
  UsersRound,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ChatListSkeleton } from "@/app/_parts/chat-list-skeleton";
import { CreateProjectFromChatDialog } from "@/app/_parts/create-project-from-chat-dialog";
import { isScheduledRunConversation } from "@/app/_parts/scheduled-run-sidebar.utils";
import { AgentIcon } from "@/components/agent-icon";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { TruncatedText } from "@/components/truncated-text";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TypingText } from "@/components/ui/typing-text";
import {
  useApps,
  useOpenAppInChat,
  useOpenExternalAppInChat,
  usePinApp,
} from "@/lib/app.query";
import { useIsAuthenticated } from "@/lib/auth/auth.hook";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useConversations,
  useDeleteConversation,
  useGenerateConversationTitle,
  usePinConversation,
  useUpdateConversation,
} from "@/lib/chat/chat.query";
import {
  getConversationDisplayTitle,
  getConversationShareTooltip,
} from "@/lib/chat/chat-utils";
import { useGlobalChat } from "@/lib/chat/global-chat.context";
import { buildPinnedSidebarItems } from "@/lib/chat/pinned-sidebar-items";
import type { Once } from "@/lib/hooks/use-once";
import { canCreateProjectFromChat } from "@/lib/projects/can-create-project-from-chat";
import { usePinProject, useProjects } from "@/lib/projects/projects.query";
import { cn } from "@/lib/utils";

const DEFAULT_SIDEBAR_CHAT_SLOTS = 3;
const MAX_TITLE_LENGTH = 100;

function ChatListFadeIn({
  fadeIn,
  children,
}: {
  fadeIn: Once;
  children: ReactNode;
}) {
  // Capture once so regular re-renders don't drop the class mid-animation.
  const [className] = useState(() =>
    fadeIn.pending() ? "animate-in fade-in-0 duration-300" : "",
  );

  useEffect(() => fadeIn.done(), [fadeIn.done]);

  return <div className={className}>{children}</div>;
}

function AISparkleIcon({ isAnimating = false }: { isAnimating?: boolean }) {
  return (
    <Sparkles
      className={`h-4 w-4 text-primary ${isAnimating ? "animate-pulse" : ""}`}
      aria-label="AI generated"
    />
  );
}

export function ChatSidebarSection({
  slots = DEFAULT_SIDEBAR_CHAT_SLOTS,
  flat = false,
  fadeIn,
}: {
  /** How many chats to show before the "More" affordance. */
  slots?: number;
  /** Render without the sub-menu indentation (used by the Chats tab). */
  flat?: boolean;
  /** One-shot latch so the list fades in only the first time it's shown this session. */
  fadeIn: Once;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const isAuthenticated = useIsAuthenticated();
  const { data: canReadConversation } = useHasPermissions({
    chat: ["read"],
  });
  const { data: conversations = [], isLoading } = useConversations({
    enabled: isAuthenticated && canReadConversation === true,
  });
  const updateConversationMutation = useUpdateConversation();
  const deleteConversationMutation = useDeleteConversation();
  const generateTitleMutation = useGenerateConversationTitle();
  const pinConversationMutation = usePinConversation();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: canUpdateConversation } = useHasPermissions({
    chat: ["update"],
  });
  const { data: canDeleteConversation } = useHasPermissions({
    chat: ["delete"],
  });
  const { data: canCreateProject } = useHasPermissions({
    project: ["create"],
  });
  const { data: canReadProjects } = useHasPermissions({
    project: ["read"],
  });
  const [createProjectConv, setCreateProjectConv] = useState<{
    id: string;
    title: string;
  } | null>(null);

  // Conversations whose title should play the typing animation (shared via chat
  // context); getSession drives the live "generating" spinner.
  const { animatingTitleIds, markTitleAnimating, getSession } = useGlobalChat();

  const { isMobile, setOpenMobile } = useSidebar();

  const currentConversationId = pathname.startsWith("/chat/")
    ? (pathname.split("/").at(-1) ?? null)
    : null;

  const recentUnpinnedChats = conversations.filter(
    (c) => !c.pinnedAt && !isScheduledRunConversation(c),
  );

  // /api/projects requires project:read; skip the fetch for roles without it
  // so the sidebar doesn't 403 (and toast) on every chat page.
  const { data: projectsData } = useProjects({
    enabled: canReadProjects === true,
  });
  const pinProjectMutation = usePinProject();
  const pinnedProjects = (projectsData ?? []).filter((p) => p.pinnedAt);
  // Pinned apps join the sidebar's Pinned section exactly like pinned projects.
  // /api/apps is access-filtered (returns the caller's accessible apps), so it
  // needs no permission gate.
  const { data: appsData } = useApps({ limit: 100, offset: 0 });
  const pinAppMutation = usePinApp();
  const openAppMutation = useOpenAppInChat();
  const openExternalAppMutation = useOpenExternalAppInChat();
  const pinnedApps = (appsData?.data ?? []).filter((a) => a.pinnedAt);
  const pinnedItems = buildPinnedSidebarItems({
    chats: conversations.filter((c) => !isScheduledRunConversation(c)),
    projects: pinnedProjects,
    apps: pinnedApps,
  });

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const handleSelectConversation = (id: string) => {
    if (isMobile) {
      setOpenMobile(false);
    }
    router.push(`/chat/${id}`);
  };

  const handleStartEdit = (id: string, currentTitle: string | null) => {
    setEditingId(id);
    setEditingTitle(currentTitle || "");
  };

  const handleSaveEdit = async (id: string) => {
    if (!editingTitle.trim()) {
      setEditingId(null);
      setEditingTitle("");
      return;
    }

    try {
      await updateConversationMutation.mutateAsync({
        id,
        title: editingTitle.trim(),
      });
      setEditingId(null);
      setEditingTitle("");
    } catch {
      // Error is handled by the mutation's onError callback
      // Keep editing state so user can retry
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingTitle("");
  };

  const handleDeleteConversation = async (id: string) => {
    // Navigate away before deleting to avoid "conversation not found" flash
    if (currentConversationId === id) {
      router.push("/chat");
    }

    try {
      await deleteConversationMutation.mutateAsync(id);
    } catch {
      // Error is handled by the mutation's onError callback
    }
  };

  const handleRegenerateTitle = (id: string) => {
    // Close edit mode
    setEditingId(null);
    setEditingTitle("");
    // Regenerate the title
    generateTitleMutation.mutate(
      { id, regenerate: true },
      {
        onSuccess: (data) => {
          if (data) markTitleAnimating(id);
        },
      },
    );
  };

  const handleTogglePin = (id: string, isPinned: boolean) => {
    pinConversationMutation.mutate({ id, pinned: !isPinned });
  };

  const handleSelectProject = (id: string) => {
    if (isMobile) {
      setOpenMobile(false);
    }
    router.push(`/projects/${id}`);
  };

  const handleUnpinProject = (id: string) => {
    pinProjectMutation.mutate({ id, pinned: false });
  };

  // Opening a pinned app is the card's canonical open action: seed a chat with
  // the app rendered and navigate to it.
  const handleSelectApp = async (appItem: (typeof pinnedApps)[number]) => {
    if (isMobile) {
      setOpenMobile(false);
    }
    const result =
      appItem.source === "owned"
        ? await openAppMutation.mutateAsync(appItem.id)
        : await openExternalAppMutation.mutateAsync({
            mcpServerId: appItem.mcpServerId,
            resourceUri: appItem.resourceUri,
          });
    if (result?.conversationId) {
      router.push(`/chat/${result.conversationId}`);
    }
  };

  const handleUnpinApp = (appItem: (typeof pinnedApps)[number]) => {
    pinAppMutation.mutate({
      pinned: false,
      target:
        appItem.source === "owned"
          ? { source: "owned", appId: appItem.id }
          : {
              source: "external",
              mcpServerId: appItem.mcpServerId,
              resourceUri: appItem.resourceUri,
            },
    });
  };

  const openConversationSearch = () => {
    window.dispatchEvent(
      new CustomEvent("open-conversation-search", {
        detail: { recentChatsView: true },
      }),
    );
  };

  const renderConversationItem = (conv: (typeof conversations)[number]) => {
    const isCurrentConversation = currentConversationId === conv.id;
    const sessionStatus = getSession(conv.id)?.status;
    const isGenerating =
      sessionStatus === "submitted" || sessionStatus === "streaming";
    // `unread` is server-derived (lastMessageAt > lastReadAt). Suppressed on the
    // chat you're viewing (its read marker is being updated) and while it is
    // actively generating (the spinner wins).
    const isUnread =
      !isGenerating && !isCurrentConversation && conv.unread === true;
    const displayTitle = getConversationDisplayTitle(conv.title, conv.messages);
    const hasRecentlyGeneratedTitle = animatingTitleIds.has(conv.id);
    const isRegenerating =
      generateTitleMutation.isPending &&
      generateTitleMutation.variables?.id === conv.id;
    const isMenuOpen = openMenuId === conv.id;
    const isPinned = !!conv.pinnedAt;
    const showCreateProject = canCreateProjectFromChat({
      hasCreatePermission: canCreateProject === true,
      conversation: conv,
    });

    return (
      <SidebarMenuSubItem key={conv.id}>
        <div className="flex items-center justify-between w-full gap-1">
          {editingId === conv.id ? (
            <div className="flex items-center gap-1 flex-1">
              <Input
                ref={inputRef}
                aria-label="Conversation title"
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                onBlur={() => handleSaveEdit(conv.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleSaveEdit(conv.id);
                  } else if (e.key === "Escape") {
                    handleCancelEdit();
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                className="h-7 text-sm flex-1"
              />
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      aria-label="Regenerate title"
                      size="icon-sm"
                      variant="ghost"
                      onMouseDown={(e) => {
                        // Prevent input blur from triggering handleSaveEdit
                        e.preventDefault();
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRegenerateTitle(conv.id);
                      }}
                      disabled={generateTitleMutation.isPending}
                      className="h-7 w-7 shrink-0"
                    >
                      <AISparkleIcon
                        isAnimating={generateTitleMutation.isPending}
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    Regenerate title with AI
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          ) : (
            <SidebarMenuButton
              onClick={() => handleSelectConversation(conv.id)}
              isActive={isCurrentConversation}
              className="cursor-pointer flex-1 justify-between"
            >
              <span className="flex items-center gap-2 min-w-0 flex-1">
                {conv.share && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <UsersRound className="h-3.5 w-3.5 shrink-0 text-primary/80" />
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        {getConversationShareTooltip(conv.share.visibility)}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                {(hasRecentlyGeneratedTitle || isRegenerating) && (
                  <AISparkleIcon isAnimating />
                )}
                {isRegenerating ? (
                  <span className="text-muted-foreground text-sm truncate">
                    Generating...
                  </span>
                ) : hasRecentlyGeneratedTitle ? (
                  <span className="truncate">
                    <TypingText
                      text={
                        displayTitle.length > MAX_TITLE_LENGTH
                          ? `${displayTitle.slice(0, MAX_TITLE_LENGTH)}...`
                          : displayTitle
                      }
                      typingSpeed={35}
                      showCursor
                      cursorClassName="bg-primary"
                    />
                  </span>
                ) : (
                  <TruncatedText
                    message={displayTitle}
                    maxLength={MAX_TITLE_LENGTH}
                    className="truncate"
                    showTooltip={false}
                  />
                )}
              </span>
              {isGenerating ? (
                <Loader2
                  aria-label="Generating"
                  data-testid={getChatItemGeneratingIndicatorTestId(conv.id)}
                  className="ml-1 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
                />
              ) : isUnread ? (
                <span
                  role="img"
                  aria-label="New messages"
                  data-testid={getChatItemUnreadIndicatorTestId(conv.id)}
                  className="ml-1 h-2 w-2 shrink-0 rounded-full bg-primary"
                />
              ) : null}
              {conv.projectName && (
                <span className="ml-1 flex max-w-24 shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
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
              {(canUpdateConversation ||
                canDeleteConversation ||
                showCreateProject) && (
                <DropdownMenu
                  open={isMenuOpen}
                  onOpenChange={(open) => setOpenMenuId(open ? conv.id : null)}
                >
                  <DropdownMenuTrigger asChild>
                    <MoreHorizontal
                      className={cn(
                        "h-4 w-4 p-0 shrink-0 transition-opacity",
                        isMenuOpen
                          ? "opacity-100"
                          : "opacity-0 group-hover/menu-sub-item:opacity-100",
                      )}
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="right">
                    {canUpdateConversation && (
                      <>
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            handleTogglePin(conv.id, isPinned);
                          }}
                        >
                          {isPinned ? (
                            <>
                              <PinOff className="h-4 w-4 mr-2" />
                              Unpin
                            </>
                          ) : (
                            <>
                              <Pin className="h-4 w-4 mr-2" />
                              Pin
                            </>
                          )}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStartEdit(conv.id, displayTitle);
                          }}
                        >
                          <Pencil className="h-4 w-4 mr-2" />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRegenerateTitle(conv.id);
                          }}
                          disabled={generateTitleMutation.isPending}
                        >
                          <Sparkles className="h-4 w-4 mr-2" />
                          Regenerate title
                        </DropdownMenuItem>
                      </>
                    )}
                    {showCreateProject && (
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenuId(null);
                          setCreateProjectConv({
                            id: conv.id,
                            title: displayTitle,
                          });
                        }}
                      >
                        <FolderPlus className="h-4 w-4 mr-2" />
                        Create project
                      </DropdownMenuItem>
                    )}
                    {canDeleteConversation && (
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteConfirmId(conv.id);
                        }}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </SidebarMenuButton>
          )}
        </div>
      </SidebarMenuSubItem>
    );
  };

  const renderProjectItem = (project: (typeof pinnedProjects)[number]) => {
    const isActive = pathname === `/projects/${project.id}`;
    const menuKey = `project:${project.id}`;
    const isMenuOpen = openMenuId === menuKey;

    return (
      <SidebarMenuSubItem key={menuKey}>
        <div className="flex items-center justify-between w-full gap-1">
          <SidebarMenuButton
            onClick={() => handleSelectProject(project.id)}
            isActive={isActive}
            className="cursor-pointer flex-1 justify-between"
          >
            <span className="flex items-center gap-2 min-w-0 flex-1">
              {project.icon ? (
                <AgentIcon
                  icon={project.icon}
                  fallbackType="project"
                  size={14}
                />
              ) : (
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <TruncatedText
                message={project.name}
                maxLength={MAX_TITLE_LENGTH}
                className="truncate"
                showTooltip={false}
              />
            </span>
            <DropdownMenu
              open={isMenuOpen}
              onOpenChange={(open) => setOpenMenuId(open ? menuKey : null)}
            >
              <DropdownMenuTrigger asChild>
                <MoreHorizontal
                  className={cn(
                    "h-4 w-4 p-0 shrink-0 transition-opacity",
                    isMenuOpen
                      ? "opacity-100"
                      : "opacity-0 group-hover/menu-sub-item:opacity-100",
                  )}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right">
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    handleUnpinProject(project.id);
                  }}
                >
                  <PinOff className="h-4 w-4 mr-2" />
                  Unpin
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuButton>
        </div>
      </SidebarMenuSubItem>
    );
  };

  // Mirrors renderProjectItem: an icon + name row that opens the app, with an
  // Unpin action in its overflow menu. Apps have no stable route, so no active
  // state.
  const renderAppItem = (appItem: (typeof pinnedApps)[number]) => {
    const menuKey =
      appItem.source === "owned"
        ? `app:${appItem.id}`
        : `app:${appItem.mcpServerId}:${appItem.resourceUri}`;
    const isMenuOpen = openMenuId === menuKey;

    return (
      <SidebarMenuSubItem key={menuKey}>
        <div className="flex items-center justify-between w-full gap-1">
          <SidebarMenuButton
            onClick={() => handleSelectApp(appItem)}
            className="cursor-pointer flex-1 justify-between"
          >
            <span className="flex items-center gap-2 min-w-0 flex-1">
              {appItem.source === "owned" ? (
                <AppWindow className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                // The backing MCP server's registry icon, matching the app's
                // card on the Apps page (falls back to the Server glyph).
                <McpCatalogIcon icon={appItem.icon} size={14} />
              )}
              <TruncatedText
                message={appItem.name}
                maxLength={MAX_TITLE_LENGTH}
                className="truncate"
                showTooltip={false}
              />
            </span>
            <DropdownMenu
              open={isMenuOpen}
              onOpenChange={(open) => setOpenMenuId(open ? menuKey : null)}
            >
              <DropdownMenuTrigger asChild>
                <MoreHorizontal
                  className={cn(
                    "h-4 w-4 p-0 shrink-0 transition-opacity",
                    isMenuOpen
                      ? "opacity-100"
                      : "opacity-0 group-hover/menu-sub-item:opacity-100",
                  )}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right">
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    handleUnpinApp(appItem);
                  }}
                >
                  <PinOff className="h-4 w-4 mr-2" />
                  Unpin
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuButton>
        </div>
      </SidebarMenuSubItem>
    );
  };

  if (
    !isLoading &&
    conversations.length === 0 &&
    pinnedProjects.length === 0 &&
    pinnedApps.length === 0
  ) {
    return null;
  }

  const subClass = flat ? "mx-0 border-l-0 px-0" : "mx-0 ml-3.5 px-0 pl-2.5";
  const showMore = recentUnpinnedChats.length > slots;

  return (
    <>
      {isLoading ? (
        <ChatListSkeleton subClass={subClass} />
      ) : (
        <ChatListFadeIn fadeIn={fadeIn}>
          {pinnedItems.length > 0 && (
            <SidebarGroup className="pt-0">
              <SidebarGroupLabel>Pinned</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuSub className={subClass}>
                      {pinnedItems.map((it) =>
                        it.type === "chat"
                          ? renderConversationItem(it.item)
                          : it.type === "project"
                            ? renderProjectItem(it.item)
                            : renderAppItem(it.item),
                      )}
                    </SidebarMenuSub>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}

          {recentUnpinnedChats.length > 0 && (
            <SidebarGroup className="pt-0">
              <SidebarGroupLabel>Recents</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuSub className={subClass}>
                      {recentUnpinnedChats
                        .slice(0, slots)
                        .map((conv) => renderConversationItem(conv))}
                      {showMore && (
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton
                            className="cursor-pointer text-sidebar-foreground/70"
                            onClick={openConversationSearch}
                          >
                            <MoreHorizontal />
                            <span>More</span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      )}
                    </SidebarMenuSub>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </ChatListFadeIn>
      )}

      <DeleteConfirmDialog
        open={deleteConfirmId !== null}
        onOpenChange={(open) => !open && setDeleteConfirmId(null)}
        title="Delete conversation?"
        description="This action cannot be undone. This will permanently delete the conversation and all its messages."
        isPending={deleteConversationMutation.isPending}
        onConfirm={async () => {
          if (deleteConfirmId) {
            await handleDeleteConversation(deleteConfirmId);
            setDeleteConfirmId(null);
          }
        }}
        confirmLabel="Delete"
        pendingLabel="Deleting..."
      />

      <CreateProjectFromChatDialog
        conversationId={createProjectConv?.id ?? null}
        defaultName={createProjectConv?.title ?? ""}
        open={createProjectConv !== null}
        onOpenChange={(open) => !open && setCreateProjectConv(null)}
      />
    </>
  );
}
