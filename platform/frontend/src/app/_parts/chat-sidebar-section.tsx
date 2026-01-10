"use client";

import {
  ChevronDown,
  ChevronRight,
  Edit2,
  Sparkles,
  Trash2,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { TruncatedText } from "@/components/truncated-text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TypingText } from "@/components/ui/typing-text";
import { WithInlineConfirm } from "@/components/ui/with-inline-confirm";
import { useRecentlyGeneratedTitles } from "@/lib/chat.hook";
import {
  useConversations,
  useDeleteConversation,
  useGenerateConversationTitle,
  useUpdateConversation,
} from "@/lib/chat.query";

const CONVERSATION_QUERY_PARAM = "conversation";
const VISIBLE_CHAT_COUNT = 10;

// Helper to extract first 15 chars from first user message
function getConversationDisplayTitle(
  title: string | null,
  // biome-ignore lint/suspicious/noExplicitAny: UIMessage structure from AI SDK is dynamic
  messages?: any[],
): string {
  if (title) return title;

  // Try to extract from first user message
  if (messages && messages.length > 0) {
    for (const msg of messages) {
      if (msg.role === "user" && msg.parts) {
        for (const part of msg.parts) {
          if (part.type === "text" && part.text) {
            return part.text;
          }
        }
      }
    }
  }

  return "New chat";
}

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
  const { data: conversations = [], isLoading } = useConversations();
  const updateConversationMutation = useUpdateConversation();
  const deleteConversationMutation = useDeleteConversation();
  const generateTitleMutation = useGenerateConversationTitle();

  const [showAllChats, setShowAllChats] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Track conversations with recently auto-generated titles for animation
  const { recentlyGeneratedTitles, regeneratingTitles, triggerRegeneration } =
    useRecentlyGeneratedTitles(conversations);

  const currentConversationId = pathname.startsWith("/chat")
    ? searchParams.get(CONVERSATION_QUERY_PARAM)
    : null;

  const visibleChats = showAllChats
    ? conversations
    : conversations.slice(0, VISIBLE_CHAT_COUNT);
  const hiddenChatsCount = Math.max(
    0,
    conversations.length - VISIBLE_CHAT_COUNT,
  );

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
    if (editingTitle.trim()) {
      await updateConversationMutation.mutateAsync({
        id,
        title: editingTitle.trim(),
      });
    }
    setEditingId(null);
    setEditingTitle("");
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingTitle("");
  };

  const handleDeleteConversation = async (id: string) => {
    // If we're deleting the current conversation, navigate to new chat
    if (currentConversationId === id) {
      router.push("/chat");
    }

    await deleteConversationMutation.mutateAsync(id);
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

  return (
    <SidebarGroup className="px-4 py-0">
      <SidebarGroupLabel>Recent Chats</SidebarGroupLabel>

      <SidebarGroupContent>
        <SidebarMenu>
          {isLoading ? (
            <SidebarMenuItem>
              <div className="flex items-center gap-2 px-2 py-1.5">
                <div className="h-3 w-3 animate-spin rounded-full border border-muted-foreground border-t-transparent" />
                <span className="text-xs text-muted-foreground">
                  Loading chats...
                </span>
              </div>
            </SidebarMenuItem>
          ) : conversations.length === 0 ? (
            <SidebarMenuItem>
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                No chats yet
              </div>
            </SidebarMenuItem>
          ) : (
            <>
              {visibleChats.map((conv) => {
                const isCurrentConversation = currentConversationId === conv.id;
                const displayTitle = getConversationDisplayTitle(
                  conv.title,
                  conv.messages,
                );
                const hasRecentlyGeneratedTitle = recentlyGeneratedTitles.has(
                  conv.id,
                );
                const isRegenerating = regeneratingTitles.has(conv.id);
                const buttons =
                  editingId !== conv.id ? (
                    <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-0.5 opacity-0 group-hover/menu-item:opacity-100 has-[[data-confirm-open]]:opacity-100 transition-opacity">
                      <PermissionButton
                        permissions={{ conversation: ["update"] }}
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStartEdit(conv.id, displayTitle);
                        }}
                        title="Edit chat name"
                        className="p-1 w-fit"
                      >
                        <Edit2 className="h-4 w-4" />
                      </PermissionButton>
                      <WithInlineConfirm
                        onConfirm={() => handleDeleteConversation(conv.id)}
                      >
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                          }}
                          title="Delete chat"
                          className="p-1 w-fit"
                        >
                          <Trash2 className="p-0 h-2 w-2 text-destructive" />
                        </Button>
                      </WithInlineConfirm>
                    </div>
                  ) : null;

                return (
                  <SidebarMenuItem key={conv.id}>
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
                                    isAnimating={
                                      generateTitleMutation.isPending
                                    }
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
                        <>
                          <SidebarMenuButton
                            onClick={() => handleSelectConversation(conv.id)}
                            isActive={isCurrentConversation}
                            className="cursor-pointer flex-1 group-hover/menu-item:bg-sidebar-accent"
                          >
                            {(hasRecentlyGeneratedTitle || isRegenerating) && (
                              <AISparkleIcon isAnimating />
                            )}
                            {isRegenerating ? (
                              <span className="flex-1 pr-0 text-muted-foreground text-sm">
                                Generating...
                              </span>
                            ) : hasRecentlyGeneratedTitle ? (
                              <span className="flex-1 pr-0 group-hover/menu-item:pr-12 transition-all overflow-hidden">
                                <TypingText
                                  text={
                                    displayTitle.length > 17
                                      ? `${displayTitle.slice(0, 17)}...`
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
                                maxLength={20}
                                className="flex-1 pr-0 group-hover/menu-item:pr-12 transition-all"
                                tooltipContentProps={{
                                  side: "right",
                                  className:
                                    "relative left-20 pointer-events-none",
                                  noArrow: true,
                                }}
                              />
                            )}
                          </SidebarMenuButton>
                          {buttons}
                        </>
                      )}
                    </div>
                  </SidebarMenuItem>
                );
              })}

              {hiddenChatsCount > 0 && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => setShowAllChats(!showAllChats)}
                    className="cursor-pointer text-xs text-muted-foreground justify-start"
                  >
                    {showAllChats ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    <span>
                      {showAllChats
                        ? "Show less"
                        : `Show ${hiddenChatsCount} more`}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
