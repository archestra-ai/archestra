"use client";

import { type UIMessage, useChat } from "@ai-sdk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DefaultChatTransport } from "ai";
import { AlertCircle } from "lucide-react";
import Link from "next/link";
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
import { AllAgentsPrompts } from "@/components/chat/all-agents-prompts";
import { ChatMessages } from "@/components/chat/chat-messages";
import { ConversationList } from "@/components/chat/conversation-list";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type ConversationWithAgent,
  useChatAgentMcpTools,
  useConversations,
  useCreateConversation,
  useDeleteConversation,
  useUpdateConversation,
} from "@/lib/chat.query";
import { useChatSettingsOptional } from "@/lib/chat-settings.query";

interface ConversationWithMessages extends ConversationWithAgent {
  messages: UIMessage[];
}

export default function ChatPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const [conversationId, setConversationId] = useState<string>();
  const [hideToolCalls, setHideToolCalls] = useState(false);
  const loadedConversationRef = useRef<string | undefined>(undefined);
  const pendingPromptRef = useRef<string | undefined>(undefined);

  // Check if API key is configured
  const { data: chatSettings } = useChatSettingsOptional();

  // Sync conversation ID with URL
  useEffect(() => {
    const conversationParam = searchParams.get("conversation");
    if (conversationParam !== conversationId) {
      setConversationId(conversationParam || undefined);
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

  // Fetch conversations with agent details
  const { data: conversations = [] } = useConversations();

  // Fetch conversation with messages
  const { data: conversation } = useQuery<ConversationWithMessages>({
    queryKey: ["conversation", conversationId],
    queryFn: async () => {
      if (!conversationId) return null;
      const res = await fetch(`/api/chat/conversations/${conversationId}`);
      if (!res.ok) {
        // If conversation was deleted (404), clear the selection gracefully
        if (res.status === 404) {
          selectConversation(undefined);
          return null;
        }
        throw new Error("Failed to fetch conversation");
      }
      return res.json();
    },
    enabled: !!conversationId,
    staleTime: 0, // Always refetch to ensure we have the latest messages
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    refetchOnWindowFocus: false, // Don't refetch when window gains focus
    retry: false, // Don't retry on error to avoid multiple 404s
  });

  // Get current agent info
  const currentAgent =
    conversation?.agent ||
    conversations.find((c) => c.id === conversationId)?.agent;

  // Fetch MCP tools from gateway (same as used in chat backend)
  const { data: mcpTools = [] } = useChatAgentMcpTools(currentAgent?.id);

  // Group tools by MCP server name (everything before the last __)
  const groupedTools = mcpTools.reduce(
    (acc, tool) => {
      const parts = tool.name.split("__");
      // Last part is tool name, everything else is server name
      const serverName =
        parts.length > 1 ? parts.slice(0, -1).join("__") : "default";
      if (!acc[serverName]) {
        acc[serverName] = [];
      }
      acc[serverName].push(tool);
      return acc;
    },
    {} as Record<string, typeof mcpTools>,
  );

  // Create conversation mutation (requires agentId)
  const createConversationMutation = useCreateConversation();

  // Handle prompt selection from all agents view
  const handleSelectPromptFromAllAgents = async (
    agentId: string,
    prompt: string,
  ) => {
    // Store the pending prompt to send after conversation loads
    // Empty string means "free chat" - don't send a message
    pendingPromptRef.current = prompt || undefined;
    // Create conversation for the selected agent
    const newConversation =
      await createConversationMutation.mutateAsync(agentId);
    if (newConversation) {
      selectConversation(newConversation.id);
    }
  };

  // Update conversation mutation
  const updateConversationMutation = useUpdateConversation();
  const handleUpdateConversation = async (id: string, title: string) => {
    await updateConversationMutation.mutateAsync({ id, title });
  };

  // Delete conversation mutation
  const deleteConversationMutation = useDeleteConversation();
  const handleDeleteConversation = async (id: string) => {
    // If we're deleting the selected conversation, clear the selection first
    // to prevent the query from trying to refetch a deleted conversation
    if (conversationId === id) {
      setConversationId(undefined);
      setMessages([]);
      router.push(pathname);
    }

    await deleteConversationMutation.mutateAsync(id);
  };

  // useChat hook for streaming (AI SDK 5.0 - manages messages only)
  const { messages, sendMessage, status, setMessages, stop, error } = useChat({
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

      // If there's a pending prompt and the conversation is empty, send it
      if (
        pendingPromptRef.current &&
        conversation.messages.length === 0 &&
        status !== "submitted" &&
        status !== "streaming"
      ) {
        const promptToSend = pendingPromptRef.current;
        pendingPromptRef.current = undefined;
        sendMessage({
          role: "user",
          parts: [{ type: "text", text: promptToSend }],
        });
      }
    } else if (conversationId && !conversation) {
      // Clear messages when switching to a conversation that's loading
      setMessages([]);
    }
  }, [conversationId, conversation, setMessages, sendMessage, status]);

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

  // If API key is not configured, show setup message
  if (chatSettings && !chatSettings.anthropicApiKeySecretId) {
    return (
      <div className="flex h-screen items-center justify-center p-8">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Anthropic API Key Required</CardTitle>
            <CardDescription>
              The chat feature requires an Anthropic API key to function.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Please configure your Anthropic API key in Chat Settings to start
              using the chat feature.
            </p>
            <Button asChild>
              <Link href="/settings/chat">Go to Chat Settings</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      {/* Sidebar - Conversation List */}
      <ConversationList
        conversations={conversations}
        selectedConversationId={conversationId}
        onSelectConversation={selectConversation}
        onNewChat={() => selectConversation(undefined)}
        onUpdateConversation={handleUpdateConversation}
        onDeleteConversation={handleDeleteConversation}
        hideToolCalls={hideToolCalls}
        onToggleHideToolCalls={setHideToolCalls}
      />

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {!conversationId ? (
          <AllAgentsPrompts onSelectPrompt={handleSelectPromptFromAllAgents} />
        ) : (
          <>
            {error && (
              <div className="border-b p-4 bg-destructive/5">
                <Alert variant="destructive" className="max-w-3xl mx-auto">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>{error.message}</AlertDescription>
                </Alert>
              </div>
            )}
            <ChatMessages
              messages={messages}
              hideToolCalls={hideToolCalls}
              status={status}
            />
            <div className="border-t p-4">
              <div className="max-w-3xl mx-auto space-y-3">
                {currentAgent && Object.keys(groupedTools).length > 0 && (
                  <div className="text-xs text-muted-foreground">
                    <TooltipProvider>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(groupedTools).map(
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
                                  {tools.map((tool) => {
                                    const parts = tool.name.split("__");
                                    const toolName =
                                      parts.length > 1
                                        ? parts[parts.length - 1]
                                        : tool.name;
                                    return (
                                      <div
                                        key={tool.name}
                                        className="text-xs border-l-2 border-primary/30 pl-2 py-0.5"
                                      >
                                        <div className="font-mono font-medium">
                                          {toolName}
                                        </div>
                                        {tool.description && (
                                          <div className="text-muted-foreground mt-0.5">
                                            {tool.description}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          ),
                        )}
                      </div>
                    </TooltipProvider>
                  </div>
                )}
                <PromptInput onSubmit={handleSubmit}>
                  <PromptInputBody>
                    <PromptInputTextarea placeholder="Type a message..." />
                  </PromptInputBody>
                  <PromptInputToolbar>
                    <PromptInputTools />
                    <PromptInputSubmit
                      status={status === "error" ? "ready" : status}
                      onStop={stop}
                    />
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
