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
  Square,
  Trash2,
  UsersRound,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ChatListSkeleton } from "@/app/_parts/chat-list-skeleton";
import { ConversationProjectActions } from "@/app/_parts/conversation-project-actions";
import { CreateProjectFromChatDialog } from "@/app/_parts/create-project-from-chat-dialog";
import { isScheduledRunConversation } from "@/app/_parts/scheduled-run-sidebar.utils";
import { AgentIcon } from "@/components/agent-icon";
import { LockedChatIcon } from "@/components/chat/locked-chat-icon";
import { RunStateIcon } from "@/components/chat/run-state-icon";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { ProjectBadgeButton } from "@/components/project-badge-button";
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
  useCancelAgentRun,
  useDeleteAgentRun,
  useMyAgentRuns,
  useUpdateAgentRun,
} from "@/lib/agent-runtime.query";
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
import { groupConversationsByDay } from "@/lib/chat/group-conversations-by-date";
import { isActionAvailableForConversation } from "@/lib/chat/locked-chat";
import { buildPinnedSidebarItems } from "@/lib/chat/pinned-sidebar-items";
import { useFeature } from "@/lib/config/config.query";
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
  const runtimeEnabled = useFeature("agentRuntime") === true;
  const { data: runs = [], isLoading: runsLoading } = useMyAgentRuns(
    isAuthenticated && canReadConversation === true && runtimeEnabled,
  );
  const updateRunMutation = useUpdateAgentRun();
  const cancelRunMutation = useCancelAgentRun();
  const deleteRunMutation = useDeleteAgentRun();
  const updateConversationMutation = useUpdateConversation();
  const deleteConversationMutation = useDeleteConversation();
  const generateTitleMutation = useGenerateConversationTitle();
  const pinConversationMutation = usePinConversation();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [editingRunId, setEditingRunId] = useState<string | null>(null);
  const [editingRunTitle, setEditingRunTitle] = useState("");
  const [stopRunId, setStopRunId] = useState<string | null>(null);
  const [deleteRunId, setDeleteRunId] = useState<string | null>(null);
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

  const currentConversationId =
    pathname.startsWith("/chat/") && !pathname.startsWith("/chat/runs/")
      ? (pathname.split("/").at(-1) ?? null)
      : null;
  const currentRunTaskId = pathname.startsWith("/chat/runs/")
    ? (pathname.split("/").at(-1) ?? null)
    : null;

  const recentUnpinnedChats = conversations.filter(
    (c) => !c.pinnedAt && !isScheduledRunConversation(c),
  );
  const recentUnpinnedRuns = runs.filter((run) => !run.pinnedAt);

  // /api/projects requires project:read; skip the fetch for roles without it
  // so the sidebar doesn't 403 (and toast) on every chat page.
  const { data: projectsData } = useProjects({
    enabled: canReadProjects === true,
  });
  const pinProjectMutation = usePinProject();
  const pinnedProjects = (projectsData ?? []).filter((p) => p.pinnedAt);
  // Pinned apps join the sidebar's Pinned section exactly like pinned projects.
  // useApps skips the request for roles without app:read.
  const { data: appsData } = useApps({ limit: 100, offset: 0 });
  const pinAppMutation = usePinApp();
  const openAppMutation = useOpenAppInChat();
  const openExternalAppMutation = useOpenExternalAppInChat();
  const pinnedApps = (appsData?.data ?? []).filter((a) => a.pinnedAt);
  const pinnedItems = buildPinnedSidebarItems({
    chats: conversations.filter((c) => !isScheduledRunConversation(c)),
    projects: pinnedProjects,
    apps: pinnedApps,
    runs,
  });

  useEffect(() => {
    if ((editingId || editingRunId) && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId, editingRunId]);

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

  const handleSaveRunTitle = async (taskId: string) => {
    const title = editingRunTitle.trim();
    if (!title) {
      setEditingRunId(null);
      setEditingRunTitle("");
      return;
    }
    try {
      await updateRunMutation.mutateAsync({ taskId, title });
      setEditingRunId(null);
      setEditingRunTitle("");
    } catch {
      // Error is handled by the mutation's onError callback.
    }
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

  const handleToggleRunPin = (taskId: string, isPinned: boolean) => {
    updateRunMutation.mutate({
      taskId,
      pinnedAt: isPinned ? null : new Date().toISOString(),
    });
  };

  const handleChangeProject = async (
    conversationId: string,
    projectId: string | null,
  ) => {
    try {
      await updateConversationMutation.mutateAsync({
        id: conversationId,
        projectId,
      });
      setOpenMenuId(null);
    } catch {
      // Error is handled by the mutation's onError callback
    }
  };

  const handleChangeRunProject = async (
    taskId: string,
    projectId: string | null,
  ) => {
    try {
      await updateRunMutation.mutateAsync({ taskId, projectId });
      setOpenMenuId(null);
    } catch {
      // Error is handled by the mutation's onError callback.
    }
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
              toolName: appItem.toolName,
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
    const showCreateProject =
      isActionAvailableForConversation(conv, "createProject") &&
      canCreateProjectFromChat({
        hasCreatePermission: canCreateProject === true,
        conversation: conv,
      });
    const showProjectActions =
      canUpdateConversation === true &&
      canReadProjects === true &&
      isActionAvailableForConversation(conv, "changeProject");
    // AI title generation is rejected for locked chats (the server would
    // have to read encrypted messages), so hide both regenerate affordances.
    const canRegenerateTitle = isActionAvailableForConversation(
      conv,
      "generateTitle",
    );

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
              {canRegenerateTitle && (
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
              )}
            </div>
          ) : (
            <SidebarMenuButton
              onClick={() => handleSelectConversation(conv.id)}
              isActive={isCurrentConversation}
              className="cursor-pointer flex-1 justify-between"
            >
              <span className="flex items-center gap-2 min-w-0 flex-1">
                {conv.lockedChat && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <LockedChatIcon className="h-3.5 w-3.5" />
                      </TooltipTrigger>
                      <TooltipContent side="top">Locked chat</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
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
                  <span
                    key="regenerating"
                    className="text-muted-foreground text-sm truncate"
                  >
                    Generating...
                  </span>
                ) : hasRecentlyGeneratedTitle ? (
                  <span key="typing" className="truncate">
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
            </SidebarMenuButton>
          )}
          {editingId !== conv.id && conv.projectId && conv.projectName && (
            <ProjectBadgeButton
              projectId={conv.projectId}
              projectName={conv.projectName}
              projectIcon={conv.projectIcon}
              compact
              onNavigate={(projectId) => {
                if (isMobile) setOpenMobile(false);
                router.push(`/projects/${projectId}`);
              }}
            />
          )}
          {/* Sibling of the row button (not nested inside it): interactive
              controls must not be nested, and the trigger must be a real
              button rather than a bare svg. */}
          {editingId !== conv.id &&
            (canUpdateConversation ||
              canDeleteConversation ||
              showCreateProject) && (
              <DropdownMenu
                open={isMenuOpen}
                onOpenChange={(open) => setOpenMenuId(open ? conv.id : null)}
              >
                <DropdownMenuTrigger asChild>
                  {/* A real button: ARIA menu attributes are not valid on a
                    bare <svg>, and an svg is not keyboard-operable. */}
                  <button
                    type="button"
                    aria-label="Chat actions"
                    className={cn(
                      "shrink-0 transition-opacity",
                      isMenuOpen
                        ? "opacity-100"
                        : "opacity-0 group-hover/menu-sub-item:opacity-100 focus-visible:opacity-100",
                    )}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="h-4 w-4 p-0" />
                  </button>
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
                      {canRegenerateTitle && (
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
                      )}
                      {showProjectActions && (
                        <ConversationProjectActions
                          projectId={conv.projectId}
                          projects={projectsData ?? []}
                          isPending={updateConversationMutation.isPending}
                          onProjectChange={(projectId) =>
                            handleChangeProject(conv.id, projectId)
                          }
                        />
                      )}
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
        </div>
      </SidebarMenuSubItem>
    );
  };

  const renderRunItem = (run: (typeof runs)[number]) => {
    const active = currentRunTaskId === run.taskId;
    const menuKey = `run:${run.taskId}`;
    const isMenuOpen = openMenuId === menuKey;
    const isEditing = editingRunId === run.taskId;
    const live = run.endedAt === null;
    const isPinned = !!run.pinnedAt;
    return (
      <SidebarMenuSubItem key={menuKey}>
        <div className="flex w-full items-center justify-between gap-1">
          {isEditing ? (
            <Input
              ref={inputRef}
              aria-label="Run title"
              value={editingRunTitle}
              onChange={(event) => setEditingRunTitle(event.target.value)}
              onBlur={() => handleSaveRunTitle(run.taskId)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  handleSaveRunTitle(run.taskId);
                } else if (event.key === "Escape") {
                  setEditingRunId(null);
                  setEditingRunTitle("");
                }
              }}
              className="h-7 flex-1 text-sm"
            />
          ) : (
            <SidebarMenuButton
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                router.push(`/chat/runs/${run.taskId}`);
              }}
              isActive={active}
              className="cursor-pointer flex-1"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <RunStateIcon
                  state={run.state}
                  startedAt={run.startedAt}
                  endedAt={run.endedAt}
                  hardDeadlineAt={run.hardDeadlineAt}
                  lastModelActivityAt={run.lastModelActivityAt}
                  className="size-3.5"
                />
                <TruncatedText
                  message={run.title}
                  maxLength={MAX_TITLE_LENGTH}
                  className="truncate"
                  showTooltip={false}
                />
              </span>
            </SidebarMenuButton>
          )}
          {!isEditing && run.projectId && run.projectName && (
            <ProjectBadgeButton
              projectId={run.projectId}
              projectName={run.projectName}
              projectIcon={run.projectIcon}
              compact
              onNavigate={(projectId) => {
                if (isMobile) setOpenMobile(false);
                router.push(`/projects/${projectId}`);
              }}
            />
          )}
          {!isEditing && (
            <DropdownMenu
              open={isMenuOpen}
              onOpenChange={(open) => setOpenMenuId(open ? menuKey : null)}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Run actions"
                  className={cn(
                    "shrink-0 transition-opacity",
                    isMenuOpen
                      ? "opacity-100"
                      : "opacity-0 group-hover/menu-sub-item:opacity-100 focus-visible:opacity-100",
                  )}
                >
                  <MoreHorizontal className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right">
                <DropdownMenuItem
                  onClick={() => handleToggleRunPin(run.taskId, isPinned)}
                >
                  {isPinned ? (
                    <>
                      <PinOff className="mr-2 size-4" />
                      Unpin
                    </>
                  ) : (
                    <>
                      <Pin className="mr-2 size-4" />
                      Pin
                    </>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setEditingRunId(run.taskId);
                    setEditingRunTitle(run.title);
                  }}
                >
                  <Pencil className="mr-2 size-4" />
                  Rename
                </DropdownMenuItem>
                {canReadProjects === true && (
                  <ConversationProjectActions
                    projectId={run.projectId}
                    projects={projectsData ?? []}
                    isPending={updateRunMutation.isPending}
                    onProjectChange={(projectId) =>
                      handleChangeRunProject(run.taskId, projectId)
                    }
                  />
                )}
                {live ? (
                  <DropdownMenuItem onClick={() => setStopRunId(run.taskId)}>
                    <Square className="mr-2 size-4" />
                    Stop
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => setDeleteRunId(run.taskId)}
                  >
                    <Trash2 className="mr-2 size-4" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
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
          </SidebarMenuButton>
          {/* Sibling of the row button: interactive controls must not nest, and
              the menu trigger must be a real button rather than a bare svg. */}
          <DropdownMenu
            open={isMenuOpen}
            onOpenChange={(open) => setOpenMenuId(open ? menuKey : null)}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Project actions"
                className={cn(
                  "shrink-0 transition-opacity",
                  isMenuOpen
                    ? "opacity-100"
                    : "opacity-0 group-hover/menu-sub-item:opacity-100 focus-visible:opacity-100",
                )}
              >
                <MoreHorizontal className="h-4 w-4 p-0" />
              </button>
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
              {/* The app's own icon for an owned app, its backing MCP server's
                  registry icon for an external one — matching the app's card on
                  the Apps page, down to the glyph each kind falls back to. */}
              <McpCatalogIcon
                icon={appItem.icon}
                size={14}
                fallback={appItem.source === "owned" ? AppWindow : undefined}
              />
              <TruncatedText
                message={appItem.name}
                maxLength={MAX_TITLE_LENGTH}
                className="truncate"
                showTooltip={false}
              />
            </span>
          </SidebarMenuButton>
          {/* Sibling of the row button: interactive controls must not nest, and
              the menu trigger must be a real button rather than a bare svg. */}
          <DropdownMenu
            open={isMenuOpen}
            onOpenChange={(open) => setOpenMenuId(open ? menuKey : null)}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="App actions"
                className={cn(
                  "shrink-0 transition-opacity",
                  isMenuOpen
                    ? "opacity-100"
                    : "opacity-0 group-hover/menu-sub-item:opacity-100 focus-visible:opacity-100",
                )}
              >
                <MoreHorizontal className="h-4 w-4 p-0" />
              </button>
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
        </div>
      </SidebarMenuSubItem>
    );
  };

  if (
    !isLoading &&
    !runsLoading &&
    conversations.length === 0 &&
    runs.length === 0 &&
    pinnedProjects.length === 0 &&
    pinnedApps.length === 0
  ) {
    return null;
  }

  const subClass = flat ? "mx-0 border-l-0 px-0" : "mx-0 ml-3.5 px-0 pl-2.5";
  const recentItems = [
    ...recentUnpinnedChats.map((item) => ({
      kind: "conversation" as const,
      item,
      timestamp: item.lastMessageAt,
    })),
    ...recentUnpinnedRuns.map((item) => ({
      kind: "run" as const,
      item,
      timestamp: item.stateChangedAt ?? item.startedAt,
    })),
  ].sort(
    (left, right) =>
      new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime(),
  );
  // Runs are operational sessions, so keep every one of them visible
  // instead of counting them against the chat slots — the rows still sort
  // into the same timeline.
  const visibleSlots = slots + recentUnpinnedRuns.length;
  const showMore = recentUnpinnedChats.length > slots;

  // The list arrives sorted by lastMessageAt desc, so grouping the visible
  // slice by the same timestamp yields contiguous date sections.
  const recentChatGroups = groupConversationsByDay(
    recentItems.slice(0, visibleSlots),
    (entry) => entry.timestamp,
  );

  return (
    <>
      {isLoading || runsLoading ? (
        <ChatListSkeleton subClass={subClass} />
      ) : (
        <ChatListFadeIn fadeIn={fadeIn}>
          {pinnedItems.length > 0 && (
            <SidebarGroup className="pt-0">
              <SidebarGroupLabel role="heading" aria-level={2}>
                Pinned
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuSub className={subClass}>
                      {pinnedItems.map((it) =>
                        it.type === "chat"
                          ? renderConversationItem(it.item)
                          : it.type === "project"
                            ? renderProjectItem(it.item)
                            : it.type === "app"
                              ? renderAppItem(it.item)
                              : renderRunItem(it.item),
                      )}
                    </SidebarMenuSub>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}

          {recentChatGroups.map((group, groupIndex) => (
            <SidebarGroup key={group.label} className="pt-0">
              <SidebarGroupLabel role="heading" aria-level={2}>
                {group.label}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuSub className={subClass}>
                      {group.chats.map((entry) =>
                        entry.kind === "conversation"
                          ? renderConversationItem(entry.item)
                          : renderRunItem(entry.item),
                      )}
                      {showMore &&
                        groupIndex === recentChatGroups.length - 1 && (
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
          ))}
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

      <DeleteConfirmDialog
        open={stopRunId !== null}
        onOpenChange={(open) => !open && setStopRunId(null)}
        title="Stop this run?"
        description="The Agent process will stop and its terminal output will be retained."
        isPending={cancelRunMutation.isPending}
        confirmLabel="Stop run"
        pendingLabel="Stopping…"
        onConfirm={async () => {
          if (!stopRunId) return;
          await cancelRunMutation.mutateAsync(stopRunId);
          setStopRunId(null);
        }}
      />

      <DeleteConfirmDialog
        open={deleteRunId !== null}
        onOpenChange={(open) => !open && setDeleteRunId(null)}
        title="Delete run?"
        description="This removes the session and its retained output. This action cannot be undone."
        isPending={deleteRunMutation.isPending}
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          if (!deleteRunId) return;
          if (currentRunTaskId === deleteRunId) {
            router.push("/chat");
          }
          await deleteRunMutation.mutateAsync(deleteRunId);
          setDeleteRunId(null);
        }}
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
