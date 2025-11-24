"use client";

import type { UIMessage } from "@ai-sdk/react";
import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import { Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CustomServerRequestDialog } from "@/app/mcp-catalog/_parts/custom-server-request-dialog";
import {
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { AllAgentsPrompts } from "@/components/chat/all-agents-prompts";
import { ChatError } from "@/components/chat/chat-error";
import { ChatMessages } from "@/components/chat/chat-messages";
import { StreamTimeoutWarning } from "@/components/chat/stream-timeout-warning";
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
import { useChatSession } from "@/contexts/global-chat-context";
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

  const [conversationId, setConversationId] = useState<string>();
  const [hideToolCalls, setHideToolCalls] = useState(() => {
    // Initialize from localStorage
    if (typeof window !== "undefined") {
      return localStorage.getItem("archestra-chat-hide-tool-calls") === "true";
    }
    return false;
  });
  const loadedConversationRef = useRef<string | undefined>(undefined);
  const pendingPromptRef = useRef<string | undefined>(undefined);
  const newlyCreatedConversationRef = useRef<string | undefined>(undefined);

  // State for MCP installation request dialogs
  const [isCustomServerDialogOpen, setIsCustomServerDialogOpen] =
    useState(false);

  const chatSession = useChatSession(conversationId);

  // Check if API key is configured
  const { data: chatSettings } = useChatSettingsOptional();

  // Sync conversation ID with URL
  useEffect(() => {
    const conversationParam = searchParams.get(CONVERSATION_QUERY_PARAM);
    if (conversationParam !== conversationId) {
      setConversationId(conversationParam || undefined);
    }
  }, [searchParams, conversationId]);

  // Update URL when conversation changes
  const selectConversation = useCallback(
    (id: string | undefined) => {
      setConversationId(id);
      if (id) {
        router.push(`${pathname}?${CONVERSATION_QUERY_PARAM}=${id}`);
      } else {
        router.push(pathname);
      }
    },
    [pathname, router],
  );

  // Fetch conversation with messages
  const { data: conversation } = useConversation(conversationId);

  // Get current agent info
  const currentAgentId = conversation?.agentId;

  // Clear MCP Gateway sessions when opening a NEW conversation
  useEffect(() => {
    // Only clear sessions if this is a newly created conversation
    if (
      currentAgentId &&
      conversationId &&
      newlyCreatedConversationRef.current === conversationId
    ) {
      // Clear sessions for this agent to ensure fresh MCP state
      fetch("/v1/mcp/sessions", {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${currentAgentId}`,
        },
      })
        .then(async () => {
          // Clear the ref after clearing sessions
          newlyCreatedConversationRef.current = undefined;
        })
        .catch((error) => {
          console.error("[Chat] Failed to clear MCP sessions:", {
            conversationId,
            agentId: currentAgentId,
            error,
          });
          // Clear the ref even on error to avoid retry loops
          newlyCreatedConversationRef.current = undefined;
        });
    }
  }, [conversationId, currentAgentId]);

  // Fetch MCP tools from gateway (same as used in chat backend)
  const { data: mcpTools = [] } = useChatAgentMcpTools(currentAgentId);

  // Group tools by MCP server name (everything before the last __)
  const groupedTools = useMemo(
    () =>
      mcpTools.reduce(
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
      ),
    [mcpTools],
  );

  // Create conversation mutation (requires agentId)
  const createConversationMutation = useCreateConversation();

  // Handle prompt selection from all agents view
  const handleSelectPromptFromAllAgents = useCallback(
    async (agentId: string, prompt: string) => {
      // Store the pending prompt to send after conversation loads
      // Empty string means "free chat" - don't send a message
      pendingPromptRef.current = prompt || undefined;
      // Create conversation for the selected agent
      const newConversation =
        await createConversationMutation.mutateAsync(agentId);
      if (newConversation) {
        // Mark this as a newly created conversation
        newlyCreatedConversationRef.current = newConversation.id;
        selectConversation(newConversation.id);
      }
    },
    [createConversationMutation, selectConversation],
  );

  // Persist hide tool calls preference
  const toggleHideToolCalls = useCallback(() => {
    const newValue = !hideToolCalls;
    setHideToolCalls(newValue);
    localStorage.setItem("archestra-chat-hide-tool-calls", String(newValue));
  }, [hideToolCalls]);

  // Extract chat session properties (or use defaults if session not ready)
  const messages = chatSession?.messages ?? [];
  const sendMessage = chatSession?.sendMessage;
  const status = chatSession?.status ?? "ready";
  const setMessages = chatSession?.setMessages;
  const stop = chatSession?.stop;
  const error = chatSession?.error;
  const addToolResult = chatSession?.addToolResult;
  const pendingCustomServerToolCall = chatSession?.pendingCustomServerToolCall;
  const setPendingCustomServerToolCall =
    chatSession?.setPendingCustomServerToolCall;

  useEffect(() => {
    if (
      !pendingCustomServerToolCall ||
      !addToolResult ||
      !setPendingCustomServerToolCall
    ) {
      return;
    }

    setIsCustomServerDialogOpen(true);

    void (async () => {
      try {
        await addToolResult({
          tool: pendingCustomServerToolCall.toolName as never,
          toolCallId: pendingCustomServerToolCall.toolCallId,
          output: {
            type: "text",
            text: "Opening the custom MCP server installation dialog.",
          } as never,
        });
      } catch (toolError) {
        console.error("[Chat] Failed to add custom server tool result", {
          toolCallId: pendingCustomServerToolCall.toolCallId,
          toolError,
        });
      }
    })();

    setPendingCustomServerToolCall(null);
  }, [
    pendingCustomServerToolCall,
    addToolResult,
    setPendingCustomServerToolCall,
  ]);

  // Sync messages when conversation loads or changes
  useEffect(() => {
    if (!setMessages || !sendMessage) {
      return;
    }

    // When switching to a different conversation, reset the loaded ref
    if (loadedConversationRef.current !== conversationId) {
      loadedConversationRef.current = undefined;
    }

    // Only sync messages from backend if:
    // 1. We have conversation data
    // 2. We haven't synced this conversation yet
    // 3. The session doesn't already have messages (don't overwrite active session)
    if (
      conversation?.messages &&
      conversation.id === conversationId &&
      loadedConversationRef.current !== conversationId &&
      messages.length === 0 // Only sync if session is empty
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
    }
  }, [
    conversationId,
    conversation,
    setMessages,
    sendMessage,
    status,
    messages,
  ]);

  const handleSubmit = useCallback(
    (
      // biome-ignore lint/suspicious/noExplicitAny: AI SDK PromptInput files type is dynamic
      message: { text?: string; files?: any[] },
      e: FormEvent<HTMLFormElement>,
    ) => {
      e.preventDefault();
      if (
        !sendMessage ||
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
    },
    [sendMessage, status],
  );

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
            {error && <ChatError error={error} />}
            <StreamTimeoutWarning status={status} messages={messages} />

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

            <div className="flex-1 overflow-y-auto">
              <ChatMessages
                messages={messages}
                hideToolCalls={hideToolCalls}
                status={status}
              />
            </div>

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

      <CustomServerRequestDialog
        isOpen={isCustomServerDialogOpen}
        onClose={() => setIsCustomServerDialogOpen(false)}
      />
    </div>
  );
}
