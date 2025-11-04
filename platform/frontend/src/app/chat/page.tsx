"use client";

import { type UIMessage, useChat } from "@ai-sdk/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DefaultChatTransport } from "ai";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { ChatMessages } from "@/components/chat/chat-messages";
import { ConversationList } from "@/components/chat/conversation-list";
import { N8nConnectionDialog } from "@/components/chat/n8n-connection-dialog";
import { PromptSuggestions } from "@/components/chat/prompt-suggestions";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface Conversation {
  id: string;
  title: string | null;
  selectedModel: string;
  userId: string;
  organizationId: string;
  createdAt: string;
  updatedAt: string;
}

interface ConversationWithMessages extends Conversation {
  messages: UIMessage[];
}

interface McpTool {
  name: string;
  description?: string;
  // biome-ignore lint/suspicious/noExplicitAny: MCP tool schemas are dynamic and come from server
  inputSchema: any;
}

export default function ChatPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const [conversationId, setConversationId] = useState<string>();
  const loadedConversationRef = useRef<string | undefined>(undefined);

  // Initialize conversation ID from URL on mount
  useEffect(() => {
    const conversationParam = searchParams.get("conversation");
    if (conversationParam && conversationParam !== conversationId) {
      setConversationId(conversationParam);
    }
  }, [searchParams, conversationId]);

  // Update URL when conversation changes
  const selectConversation = (id: string | undefined) => {
    setConversationId(id);
    if (id) {
      router.push(`${pathname}?conversation=${id}`);
    } else {
      router.push(pathname);
    }
  };

  // Fetch conversations
  const { data: conversations = [] } = useQuery<Conversation[]>({
    queryKey: ["conversations"],
    queryFn: async () => {
      const res = await fetch("/api/chat/conversations");
      if (!res.ok) throw new Error("Failed to fetch conversations");
      return res.json();
    },
    staleTime: 5 * 60 * 1000, // 5 minutes - don't refetch unless explicitly invalidated
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    refetchOnWindowFocus: false, // Don't refetch when window gains focus
  });

  // Fetch conversation with messages
  const { data: conversation } = useQuery<ConversationWithMessages>({
    queryKey: ["conversation", conversationId],
    queryFn: async () => {
      if (!conversationId) return null;
      const res = await fetch(`/api/chat/conversations/${conversationId}`);
      if (!res.ok) throw new Error("Failed to fetch conversation");
      return res.json();
    },
    enabled: !!conversationId,
    staleTime: 0, // Always refetch to ensure we have the latest messages
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    refetchOnWindowFocus: false, // Don't refetch when window gains focus
  });

  // Fetch available MCP tools
  const { data: mcpTools = [] } = useQuery<McpTool[]>({
    queryKey: ["mcp-tools"],
    queryFn: async () => {
      const res = await fetch("/api/chat/mcp-tools");
      if (!res.ok) throw new Error("Failed to fetch MCP tools");
      return res.json();
    },
    staleTime: 5 * 60 * 1000, // 5 minutes - tools don't change often
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // Create conversation mutation
  const createConversation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/chat/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("Failed to create conversation");
      return res.json();
    },
    onSuccess: (newConversation) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      selectConversation(newConversation.id);
    },
  });

  // Delete conversation mutation
  const deleteConversation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/chat/conversations/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete conversation");
      return res.json();
    },
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.removeQueries({ queryKey: ["conversation", deletedId] });

      // If we deleted the selected conversation, clear the selection
      if (conversationId === deletedId) {
        setConversationId(undefined);
        setMessages([]);
        router.push(pathname);
      }
    },
  });

  // useChat hook for streaming (AI SDK 5.0 - manages messages only)
  const { messages, sendMessage, status, setMessages } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat", // Must match backend route
      credentials: "include", // Send cookies for authentication
    }),
    id: conversationId,
    onFinish: () => {
      // Invalidate the conversation query to refetch with new messages
      if (conversationId) {
        queryClient.invalidateQueries({
          queryKey: ["conversation", conversationId],
        });
      }
    },
  });

  // Sync messages when conversation loads or changes
  useEffect(() => {
    // When switching to a different conversation, reset the loaded ref
    if (loadedConversationRef.current !== conversationId) {
      loadedConversationRef.current = undefined;
    }

    // If we have conversation data and haven't synced it yet, sync it
    if (
      conversation?.messages &&
      conversation.id === conversationId &&
      loadedConversationRef.current !== conversationId
    ) {
      setMessages(conversation.messages);
      loadedConversationRef.current = conversationId;
    } else if (conversationId && !conversation) {
      // Clear messages when switching to a conversation that's loading
      setMessages([]);
    }
  }, [conversationId, conversation, setMessages]);

  const handleSubmit = (
    // biome-ignore lint/suspicious/noExplicitAny: AI SDK PromptInput files type is dynamic
    message: { text?: string; files?: any[] },
    e: FormEvent<HTMLFormElement>,
  ) => {
    e.preventDefault();
    if (
      !message.text?.trim() ||
      status === "submitted" ||
      status === "streaming"
    ) {
      return;
    }

    sendMessage({
      role: "user",
      parts: [{ type: "text", text: message.text }],
    });
  };

  const handleSelectPrompt = (prompt: string) => {
    // Send the message directly instead of just filling the input
    if (status === "submitted" || status === "streaming") {
      return;
    }

    sendMessage({
      role: "user",
      parts: [{ type: "text", text: prompt }],
    });
  };

  // Group tools by MCP server (prefix before "__")
  const mcpServerGroups = mcpTools.reduce(
    (acc, tool) => {
      const prefix = tool.name.includes("__")
        ? tool.name.split("__")[0]
        : "other";

      if (!acc[prefix]) {
        acc[prefix] = [];
      }
      acc[prefix].push(tool);
      return acc;
    },
    {} as Record<string, McpTool[]>,
  );

  return (
    <div className="flex h-screen">
      {/* Sidebar - Conversation List */}
      <ConversationList
        conversations={conversations}
        selectedConversationId={conversationId}
        onSelectConversation={selectConversation}
        onCreateConversation={() => createConversation.mutate()}
        onDeleteConversation={(id) => deleteConversation.mutate(id)}
        isCreatingConversation={createConversation.isPending}
      />

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {!conversationId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <p className="text-lg mb-2">No conversation selected</p>
              <p className="text-sm">Create a new chat to get started</p>
            </div>
          </div>
        ) : (
          <>
            {messages.length === 0 ? (
              <PromptSuggestions onSelectPrompt={handleSelectPrompt} />
            ) : (
              <ChatMessages messages={messages} />
            )}
            <div className="border-t p-4">
              <div className="max-w-3xl mx-auto space-y-3">
                {mcpTools.length > 0 && (
                  <div className="text-xs text-muted-foreground">
                    <TooltipProvider>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <div className="flex flex-wrap gap-1.5">
                          {Object.entries(mcpServerGroups).map(
                            ([serverName, tools]) => (
                              <Tooltip key={serverName}>
                                <TooltipTrigger asChild>
                                  <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary text-foreground cursor-default">
                                    <span className="font-medium">
                                      {serverName}
                                    </span>
                                    <span className="text-muted-foreground">
                                      ({tools.length}{" "}
                                      {tools.length === 1 ? "tool" : "tools"})
                                    </span>
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent
                                  side="top"
                                  className="max-w-sm max-h-64 overflow-y-auto"
                                >
                                  <div className="space-y-1">
                                    {tools.map((tool) => (
                                      <div
                                        key={tool.name}
                                        className="text-xs border-l-2 border-primary/30 pl-2 py-0.5"
                                      >
                                        <div className="font-mono font-medium">
                                          {tool.name.split("__")[1] ||
                                            tool.name}
                                        </div>
                                        {tool.description && (
                                          <div className="text-muted-foreground mt-0.5">
                                            {tool.description}
                                          </div>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                            ),
                          )}
                        </div>
                        <N8nConnectionDialog />
                      </div>
                    </TooltipProvider>
                  </div>
                )}
                {mcpTools.length === 0 && (
                  <div className="flex justify-end">
                    <N8nConnectionDialog />
                  </div>
                )}
                <PromptInput onSubmit={handleSubmit}>
                  <PromptInputBody>
                    <PromptInputTextarea placeholder="Type a message..." />
                  </PromptInputBody>
                  <PromptInputToolbar>
                    <PromptInputTools />
                    <PromptInputSubmit status={status} />
                  </PromptInputToolbar>
                </PromptInput>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
