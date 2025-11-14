"use client";

import { ChevronDown, ChevronRight, Edit2, Trash2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
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
import {
  useConversations,
  useDeleteConversation,
  useUpdateConversation,
} from "@/lib/chat.query";

const CONVERSATION_QUERY_PARAM = "conversation";
const VISIBLE_CHAT_COUNT = 10;

export function ChatSidebarSection() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: conversations = [], isLoading } = useConversations();
  const updateConversationMutation = useUpdateConversation();
  const deleteConversationMutation = useDeleteConversation();

  const [showAllChats, setShowAllChats] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

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

  const handleSelectConversation = useCallback(
    (id: string) => {
      router.push(`/chat?${CONVERSATION_QUERY_PARAM}=${id}`);
    },
    [router],
  );

  const handleStartEdit = useCallback(
    (id: string, currentTitle: string | null) => {
      setEditingId(id);
      setEditingTitle(currentTitle || "");
    },
    [],
  );

  const handleSaveEdit = useCallback(
    async (id: string) => {
      if (editingTitle.trim()) {
        await updateConversationMutation.mutateAsync({
          id,
          title: editingTitle.trim(),
        });
      }
      setEditingId(null);
      setEditingTitle("");
    },
    [editingTitle, updateConversationMutation],
  );

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    setEditingTitle("");
  }, []);

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      // If we're deleting the current conversation, navigate to new chat
      if (currentConversationId === id) {
        router.push("/chat");
      }

      await deleteConversationMutation.mutateAsync(id);
    },
    [currentConversationId, deleteConversationMutation, router],
  );

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
              {/* Conversation List */}
              {visibleChats.map((conv) => {
                const isCurrentConversation = currentConversationId === conv.id;

                return (
                  <SidebarMenuItem key={conv.id} className="group/chat-item">
                    <div className="flex items-center w-full gap-1">
                      {editingId === conv.id ? (
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
                      ) : (
                        <TooltipProvider delayDuration={300}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <SidebarMenuButton
                                onClick={() =>
                                  handleSelectConversation(conv.id)
                                }
                                isActive={isCurrentConversation}
                                className="cursor-pointer flex-1 pr-1 justify-start"
                              >
                                <span
                                  className="truncate"
                                  title={conv.title || "New chat"}
                                >
                                  {conv.title || "New chat"}
                                </span>
                              </SidebarMenuButton>
                            </TooltipTrigger>
                            <TooltipContent side="right">
                              <p>{conv.agent.name}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                      {editingId !== conv.id && (
                        <div className="flex gap-0.5 opacity-0 group-hover/chat-item:opacity-100 transition-opacity shrink-0">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStartEdit(conv.id, conv.title);
                            }}
                            className="p-1 hover:bg-muted rounded shrink-0"
                            title="Edit chat name"
                          >
                            <Edit2 className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteConversation(conv.id);
                            }}
                            className="p-1 hover:bg-destructive/10 rounded shrink-0"
                            title="Delete chat"
                          >
                            <Trash2 className="h-3 w-3 text-destructive" />
                          </button>
                        </div>
                      )}
                    </div>
                  </SidebarMenuItem>
                );
              })}

              {/* Show More/Less Toggle */}
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
