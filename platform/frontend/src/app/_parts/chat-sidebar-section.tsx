"use client";

import {
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Sparkles,
  Trash2,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { TruncatedText } from "@/components/truncated-text";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TypingText } from "@/components/ui/typing-text";
import { useIsAuthenticated } from "@/lib/auth.hook";
import { useHasPermissions } from "@/lib/auth.query";
import { useRecentlyGeneratedTitles } from "@/lib/chat.hook";
import {
  useConversations,
  useDeleteConversation,
  useGenerateConversationTitle,
  usePinConversation,
  useUpdateConversation,
} from "@/lib/chat.query";
import { getConversationDisplayTitle } from "@/lib/chat-utils";
import { cn } from "@/lib/utils";

const CONVERSATION_QUERY_PARAM = "conversation";
const SIDEBAR_CHAT_SLOTS = 3;
const MAX_TITLE_LENGTH = 100;

function AISparkleIcon({ isAnimating = false }: { isAnimating?: boolean }) {
  return (
    <Sparkles
      className={`h-4 w-4 text-primary ${isAnimating ? "animate-pulse" : ""}`}
      aria-label="AI generated"
    />
  );
}

export function ChatSidebarSection() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isAuthenticated = useIsAuthenticated();
  const { data: conversations = [], isLoading } = useConversations({
    enabled: isAuthenticated,
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
    conversation: ["update"],
  });
  const { data: canDeleteConversation } = useHasPermissions({
    conversation: ["delete"],
  });

  // Track conversations with recently auto-generated titles for animation
  const { recentlyGeneratedTitles, regeneratingTitles, triggerRegeneration } =
    useRecentlyGeneratedTitles(conversations);

  const currentConversationId = pathname.startsWith("/chat")
    ? searchParams.get(CONVERSATION_QUERY_PARAM)
    : null;

  // Split conversations into pinned and unpinned.
  // Default view shows exactly SIDEBAR_CHAT_SLOTS items:
  // pinned chats first (most recently active), then recent unpinned to fill remaining slots.
  const { pinnedChats, recentUnpinnedChats } = useMemo(() => {
    const pinned = conversations
      .filter((c) => c.pinnedAt)
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
      .slice(0, SIDEBAR_CHAT_SLOTS);

    const pinnedIds = new Set(pinned.map((c) => c.id));
    const unpinned = conversations.filter((c) => !pinnedIds.has(c.id));
    const remainingSlots = Math.max(0, SIDEBAR_CHAT_SLOTS - pinned.length);

    return {
      pinnedChats: pinned,
      recentUnpinnedChats: unpinned.slice(0, remainingSlots),
    };
  }, [conversations]);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const handleSelectConversation = (id: string) => {
    router.push(`/chat?${CONVERSATION_QUERY_PARAM}=${id}`);
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
    const shouldNavigate = currentConversationId === id;

    try {
      await deleteConversationMutation.mutateAsync(id);
      // Navigate only after successful deletion
      if (shouldNavigate) {
        router.push("/chat");
      }
    } catch {
      // Error is handled by the mutation's onError callback
    }
  };

  const handleRegenerateTitle = async (id: string) => {
    // Mark as regenerating (shows loading state until new title arrives)
    triggerRegeneration(id);
    // Close edit mode
    setEditingId(null);
    setEditingTitle("");
    // Regenerate the title
    await generateTitleMutation.mutateAsync({ id, regenerate: true });
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
    const hasRecentlyGeneratedTitle = recentlyGeneratedTitles.has(conv.id);
    const isRegenerating = regeneratingTitles.has(conv.id);
    const isMenuOpen = openMenuId === conv.id;
    const isPinned = !!conv.pinnedAt;

    return (
      <SidebarMenuSubItem key={conv.id}>
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
                {showPinIcon && (
                  <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />
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
      </SidebarMenuSubItem>
    );
  };

  if (!isLoading && conversations.length === 0) {
    return null;
  }

  return (
    <>
      <SidebarMenuSub className="mx-0 ml-3.5 px-0 pl-2.5">
        {isLoading ? (
          <SidebarMenuSubItem>
            <div className="flex items-center gap-2 px-2 py-1.5">
              <div className="h-3 w-3 animate-spin rounded-full border border-muted-foreground border-t-transparent" />
              <span className="text-xs text-muted-foreground">
                Loading chats...
              </span>
            </div>
          </SidebarMenuSubItem>
        ) : (
          <>
            {pinnedChats.map((conv) => renderConversationItem(conv, true))}
            {recentUnpinnedChats.map((conv) => renderConversationItem(conv))}
            {conversations.length >
              pinnedChats.length + recentUnpinnedChats.length && (
              <SidebarMenuSubItem>
                <SidebarMenuSubButton
                  className="text-sidebar-foreground/70"
                  onClick={openConversationSearch}
                >
                  <MoreHorizontal />
                  <span>More</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            )}
          </>
        )}
      </SidebarMenuSub>

      <AlertDialog
        open={deleteConfirmId !== null}
        onOpenChange={(open) => !open && setDeleteConfirmId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the
              conversation and all its messages.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteConversationMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (deleteConfirmId) {
                  await handleDeleteConversation(deleteConfirmId);
                  setDeleteConfirmId(null); // Close dialog only after successful deletion
                }
              }}
              disabled={deleteConversationMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteConversationMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
