"use client";

import { type UIMessage, useChat } from "@ai-sdk/react";
import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { DefaultChatTransport } from "ai";
import { AlertCircle, Eye, EyeOff } from "lucide-react";
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
  useChatAgentMcpTools,
  useConversation,
  useCreateConversation,
} from "@/lib/chat.query";
import { useChatSettingsOptional } from "@/lib/chat-settings.query";

const CONVERSATION_QUERY_PARAM = "conversation";

export default function ChatPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const [conversationId, setConversationId] = useState<string>();
  const [hideToolCalls, setHideToolCalls] = useState(() => {
    // Initialize from localStorage
    if (typeof window !== "undefined") {
      return localStorage.getItem("archestra-chat-hide-tool-calls") === "true";
    }
    return false;
  });
  const [hasInitialized, setHasInitialized] = useState(false);
  const loadedConversationRef = useRef<string | undefined>(undefined);
  const pendingPromptRef = useRef<string | undefined>(undefined);

  // Check if API key is configured
  const { data: chatSettings } = useChatSettingsOptional();

  // Initialize
  useEffect(() => {
    if (hasInitialized) return;
    setHasInitialized(true);
  }, [hasInitialized]);

  // Sync conversation ID with URL
  useEffect(() => {
    const conversationParam = searchParams.get(CONVERSATION_QUERY_PARAM);
    if (conversationParam !== conversationId) {
      setConversationId(conversationParam || undefined);
    }
  }, [searchParams, conversationId]);

  // Update URL when conversation changes
  const selectConversation = (id: string | undefined) => {
    setConversationId(id);
    if (id) {
      router.push(`${pathname}?${CONVERSATION_QUERY_PARAM}=${id}`);
    } else {
      router.push(pathname);
    }
  };

  // Fetch conversation with messages
  const { data: conversation } = useConversation(conversationId);

  // Get current agent info
  const currentAgentId = conversation?.agentId;

  // Fetch MCP tools from gateway (same as used in chat backend)
  const { data: mcpTools = [] } = useChatAgentMcpTools(currentAgentId);

  // Group tools by MCP server name (everything before the last __)
  const groupedTools = mcpTools.reduce(
    (acc, tool) => {
      const parts = tool.name.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
      // Last part is tool name, everything else is server name
      const serverName =
        parts.length > 1
          ? parts.slice(0, -1).join(MCP_SERVER_TOOL_NAME_SEPARATOR)
          : "default";
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

  // Persist hide tool calls preference
  const toggleHideToolCalls = () => {
    const newValue = !hideToolCalls;
    setHideToolCalls(newValue);
    localStorage.setItem("archestra-chat-hide-tool-calls", String(newValue));
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
      setMessages(conversation.messages as UIMessage[]);
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
    <div className="flex h-screen w-full">
      <div className="flex-1 flex flex-col w-full">
        {!conversationId ? (
          <AllAgentsPrompts onSelectPrompt={handleSelectPromptFromAllAgents} />
        ) : (
          <div className="flex flex-col h-full">
            {error && (
              <div className="border-b p-4 bg-destructive/5">
                <Alert variant="destructive" className="max-w-3xl mx-auto">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>{error.message}</AlertDescription>
                </Alert>
              </div>
            )}

            {/* Sticky top bar with agent name and toggle */}
            <div className="sticky top-0 z-10 bg-background border-b p-2 flex items-center justify-between">
              <div className="flex-1" />
              {conversation?.agent?.name && (
                <div className="flex-1 text-center">
                  <span className="text-sm font-medium text-muted-foreground">
                    {conversation.agent.name}
                  </span>
                </div>
              )}
              <div className="flex-1 flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleHideToolCalls}
                  className="text-xs"
                >
                  {hideToolCalls ? (
                    <>
                      <Eye className="h-3 w-3 mr-1" />
                      Show tool calls
                    </>
                  ) : (
                    <>
                      <EyeOff className="h-3 w-3 mr-1" />
                      Hide tool calls
                    </>
                  )}
                </Button>
              </div>
            </div>

            {/* Scrollable messages area */}
            <div className="flex-1 overflow-y-auto">
              <ChatMessages
                messages={messages}
                hideToolCalls={hideToolCalls}
                status={status}
              />
            </div>

            {/* Sticky bottom input area */}
            <div className="sticky bottom-0 bg-background border-t p-4">
              <div className="max-w-3xl mx-auto space-y-3">
                {currentAgentId && Object.keys(groupedTools).length > 0 && (
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
                                    const parts = tool.name.split(
                                      MCP_SERVER_TOOL_NAME_SEPARATOR,
                                    );
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
          </div>
        )}
      </div>
    </div>
  );
}
