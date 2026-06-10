"use client";

import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderInput,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UsersRound,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { TruncatedText } from "@/components/truncated-text";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSubButton,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TypingText } from "@/components/ui/typing-text";
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
import { useProjects } from "@/lib/project.query";
import { cn } from "@/lib/utils";

const MAX_TITLE_LENGTH = 100;
const SIDEBAR_GROUP_SESSION_LIMIT = 5;
type GroupMode = "none" | "date" | "project";

function AISparkleIcon({ isAnimating = false }: { isAnimating?: boolean }) {
  return (
    <Sparkles
      className={`h-4 w-4 text-primary ${isAnimating ? "animate-pulse" : ""}`}
      aria-label="AI generated"
    />
  );
}

function groupConversationsByDate<T extends { updatedAt: string }>(
  conversations: T[],
): Array<{ label: string; conversations: T[] }> {
  const groups = new Map<string, T[]>();
  for (const conversation of conversations) {
    const label = new Date(conversation.updatedAt).toLocaleDateString(
      undefined,
      {
        month: "short",
        day: "numeric",
        year: "numeric",
      },
    );
    groups.set(label, [...(groups.get(label) ?? []), conversation]);
  }
  return Array.from(groups.entries()).map(([label, groupedConversations]) => ({
    label,
    conversations: groupedConversations,
  }));
}

export function ChatSidebarSection() {
  const router = useRouter();
  const pathname = usePathname();
  const isAuthenticated = useIsAuthenticated();
  const { data: canReadConversation } = useHasPermissions({
    chat: ["read"],
  });
  const { data: canReadProject } = useHasPermissions({
    project: ["read"],
  });
  const { data: conversations = [], isLoading } = useConversations({
    enabled: isAuthenticated && canReadConversation === true,
  });
  const { data: projectsResponse, isLoading: isProjectsLoading } = useProjects({
    limit: 20,
    offset: 0,
    enabled: isAuthenticated && canReadProject === true,
  });
  const updateConversationMutation = useUpdateConversation();
  const deleteConversationMutation = useDeleteConversation();
  const generateTitleMutation = useGenerateConversationTitle();
  const pinConversationMutation = usePinConversation();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [groupMode, setGroupMode] = useState<GroupMode>("project");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: canUpdateConversation } = useHasPermissions({
    chat: ["update"],
  });
  const { data: canDeleteConversation } = useHasPermissions({
    chat: ["delete"],
  });

  // Conversations whose title should play the typing animation (shared via chat context)
  const { animatingTitleIds, markTitleAnimating } = useGlobalChat();

  const { isMobile, setOpenMobile } = useSidebar();

  const currentConversationId = pathname.startsWith("/chat/")
    ? (pathname.split("/").at(-1) ?? null)
    : null;

  const projects = projectsResponse?.data ?? [];
  const pinnedConversations = conversations.filter(
    (conversation) => !!conversation.pinnedAt,
  );
  const unpinnedConversations = conversations.filter(
    (conversation) => !conversation.pinnedAt,
  );
  const projectConversations = projects.map((project) => ({
    project,
    conversations: unpinnedConversations.filter(
      (conversation) => conversation.projectId === project.id,
    ),
  }));
  const otherConversations = unpinnedConversations.filter(
    (conversation) => !conversation.projectId,
  );
  const dateConversationGroups = groupConversationsByDate(
    unpinnedConversations,
  );

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
    const conversation = conversations.find((item) => item.id === id);
    router.push(
      conversation?.projectId
        ? `/projects/${conversation.projectId}?conversationId=${id}`
        : `/chat/${id}`,
    );
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

  const openConversationSearch = () => {
    window.dispatchEvent(
      new CustomEvent("open-conversation-search", {
        detail: { recentChatsView: true },
      }),
    );
  };

  const renderConversationItem = (
    conv: (typeof conversations)[number],
    showPinIcon = false,
  ) => {
    const isCurrentConversation = currentConversationId === conv.id;
    const displayTitle = getConversationDisplayTitle(conv.title, conv.messages);
    const hasRecentlyGeneratedTitle = animatingTitleIds.has(conv.id);
    const isRegenerating =
      generateTitleMutation.isPending &&
      generateTitleMutation.variables?.id === conv.id;
    const isMenuOpen = openMenuId === conv.id;
    const isPinned = !!conv.pinnedAt;

    return (
      <div key={conv.id} className="group/menu-sub-item relative">
        <div className="flex items-center justify-between w-full gap-1">
          {editingId === conv.id ? (
            <div className="flex items-center gap-1 flex-1">
              <Input
                ref={inputRef}
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
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full border",
                    isCurrentConversation
                      ? "border-primary bg-primary"
                      : "border-muted-foreground/45",
                  )}
                />
                {showPinIcon && (
                  <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />
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
              {(canUpdateConversation || canDeleteConversation) && (
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
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <FolderInput className="h-4 w-4 mr-2" />
                            Move to project
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            {projects.map((project) => (
                              <DropdownMenuItem
                                key={project.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  updateConversationMutation.mutate({
                                    id: conv.id,
                                    projectId: project.id,
                                  });
                                }}
                              >
                                {project.name}
                              </DropdownMenuItem>
                            ))}
                            {projects.length > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                updateConversationMutation.mutate({
                                  id: conv.id,
                                  projectId: null,
                                });
                              }}
                            >
                              Remove from project
                            </DropdownMenuItem>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
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
      </div>
    );
  };

  const handleSelectProject = (id: string) => {
    if (isMobile) {
      setOpenMobile(false);
    }
    router.push(`/projects/${id}`);
  };

  const handleSelectProjectsPage = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
    router.push("/projects");
  };

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const renderGroupActions = (projectId?: string) => (
    <div className="flex shrink-0 items-center gap-1">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() =>
                projectId
                  ? handleSelectProject(projectId)
                  : handleSelectProjectsPage()
              }
              className="size-5 text-sidebar-foreground/70 hover:text-sidebar-foreground"
            >
              <ExternalLink className="h-2.5 w-2.5" />
              <span className="sr-only">View projects</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {projectId ? "View project" : "View projects"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-5 text-sidebar-foreground/70 hover:text-sidebar-foreground data-[state=open]:bg-sidebar-accent"
          >
            <SlidersHorizontal className="h-2.5 w-2.5" />
            <span className="sr-only">Group chats</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="right">
          <DropdownMenuLabel className="text-muted-foreground">
            Group by
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={groupMode}
            onValueChange={(value) => setGroupMode(value as GroupMode)}
          >
            <DropdownMenuRadioItem value="none">None</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="date">Date</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="project">
              Project
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const renderLimitedConversationGroup = (params: {
    conversations: typeof conversations;
    emptyMessage?: string;
    groupId: string;
    overflowHref?: string;
    overflowLabel?: string;
  }) => {
    const isCollapsed = collapsedGroups.has(params.groupId);
    if (isCollapsed) return null;

    if (params.conversations.length === 0) {
      return params.emptyMessage ? (
        <div className="ml-6 px-2 py-1 text-xs text-muted-foreground">
          {params.emptyMessage}
        </div>
      ) : null;
    }

    const visibleConversations = params.conversations.slice(
      0,
      SIDEBAR_GROUP_SESSION_LIMIT,
    );
    const hiddenCount =
      params.conversations.length - visibleConversations.length;

    return (
      <>
        {visibleConversations.map((conv) => renderConversationItem(conv))}
        {hiddenCount > 0 && params.overflowHref ? (
          <button
            type="button"
            onClick={() => {
              if (isMobile) setOpenMobile(false);
              router.push(params.overflowHref ?? "/chat");
            }}
            className="w-full px-8 py-1 text-left text-xs text-sidebar-foreground/55 hover:text-sidebar-foreground"
          >
            {params.overflowLabel ?? `View ${hiddenCount} more`}
          </button>
        ) : null}
      </>
    );
  };

  if (
    !isLoading &&
    !isProjectsLoading &&
    conversations.length === 0 &&
    projects.length === 0
  ) {
    return null;
  }

  return (
    <>
      <SidebarMenuItem className="group-data-[collapsible=icon]:hidden">
        <div className="mt-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            {isLoading || isProjectsLoading ? (
              <div>
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <div className="h-3 w-3 animate-spin rounded-full border border-muted-foreground border-t-transparent" />
                  <span className="text-xs text-muted-foreground">
                    Loading chats...
                  </span>
                </div>
              </div>
            ) : (
              <>
                {groupMode === "project" && pinnedConversations.length > 0 && (
                  <div className="space-y-0.5">
                    <div className="px-2 pt-1 text-sm font-medium text-muted-foreground">
                      Pinned
                    </div>
                    {pinnedConversations.map((conv) =>
                      renderConversationItem(conv),
                    )}
                  </div>
                )}

                {groupMode === "project" &&
                  projectConversations.map(({ project, conversations }) => (
                    <div key={project.id}>
                      <div className="group/project space-y-0.5">
                        <div className="flex items-center gap-1">
                          <SidebarMenuSubButton
                            className="min-w-0 flex-1 cursor-pointer px-2 text-sidebar-foreground/70 hover:text-sidebar-foreground"
                            onClick={() => toggleGroup(`project:${project.id}`)}
                          >
                            <span className="truncate">{project.name}</span>
                            <ChevronDown
                              className={cn(
                                "h-3.5 w-3.5 text-muted-foreground/70 transition-transform",
                                collapsedGroups.has(`project:${project.id}`) &&
                                  "-rotate-90",
                              )}
                            />
                          </SidebarMenuSubButton>
                          {renderGroupActions(project.id)}
                        </div>
                        {renderLimitedConversationGroup({
                          conversations,
                          emptyMessage: "No chats yet",
                          groupId: `project:${project.id}`,
                          overflowHref: `/projects/${project.id}`,
                          overflowLabel: `View all ${conversations.length} chats`,
                        })}
                      </div>
                    </div>
                  ))}

                {groupMode === "project" && (
                  <>
                    <div className="group/other">
                      <div className="flex items-center gap-1 px-2">
                        <SidebarMenuSubButton
                          className="h-7 min-w-0 flex-none cursor-pointer px-0 text-sidebar-foreground/70 hover:bg-transparent hover:text-sidebar-foreground"
                          onClick={() => toggleGroup("other")}
                        >
                          Other
                          <ChevronDown
                            className={cn(
                              "h-3.5 w-3.5 text-muted-foreground/70 transition-transform",
                              collapsedGroups.has("other") && "-rotate-90",
                            )}
                          />
                        </SidebarMenuSubButton>
                        <button
                          type="button"
                          onClick={openConversationSearch}
                          className="ml-auto flex items-center gap-0.5 text-xs text-sidebar-foreground/55 opacity-0 transition-opacity hover:text-sidebar-foreground group-hover/other:opacity-100 focus-visible:opacity-100"
                        >
                          View all
                          <ChevronRight className="h-3 w-3" />
                        </button>
                        {projectConversations.length === 0
                          ? renderGroupActions()
                          : null}
                      </div>
                    </div>
                    {renderLimitedConversationGroup({
                      conversations: otherConversations,
                      groupId: "other",
                      overflowHref: "/chat",
                      overflowLabel: `View all ${otherConversations.length} chats`,
                    })}
                  </>
                )}

                {groupMode === "date" &&
                  dateConversationGroups.map((group) => (
                    <div key={group.label}>
                      <div className="space-y-0.5">
                        <div className="flex items-center justify-between gap-2 px-2 pt-1">
                          <div className="text-sm font-medium text-muted-foreground">
                            {group.label}
                          </div>
                          {group === dateConversationGroups[0]
                            ? renderGroupActions()
                            : null}
                        </div>
                        {group.conversations.map((conv) =>
                          renderConversationItem(conv, !!conv.pinnedAt),
                        )}
                      </div>
                    </div>
                  ))}

                {groupMode === "none" && (
                  <>
                    <div>
                      <div className="flex items-center justify-between gap-2 px-2 pt-1">
                        <div className="text-sm font-medium text-muted-foreground">
                          Chats
                        </div>
                        {renderGroupActions()}
                      </div>
                    </div>
                    {unpinnedConversations.map((conv) =>
                      renderConversationItem(conv, !!conv.pinnedAt),
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </SidebarMenuItem>

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
    </>
  );
}
