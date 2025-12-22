"use client";

import type { UIMessage } from "@ai-sdk/react";
import { Eye, EyeOff, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CreateCatalogDialog } from "@/app/mcp-catalog/_parts/create-catalog-dialog";
import { CustomServerRequestDialog } from "@/app/mcp-catalog/_parts/custom-server-request-dialog";
import type { PromptInputProps } from "@/components/ai-elements/prompt-input";
import { ChatMessages } from "@/components/chat/chat-messages";
import { PromptDialog } from "@/components/chat/prompt-dialog";
import { PromptLibraryGrid } from "@/components/chat/prompt-library-grid";
import { PromptVersionHistoryDialog } from "@/components/chat/prompt-version-history-dialog";
import { StreamTimeoutWarning } from "@/components/chat/stream-timeout-warning";
import { PageLayout } from "@/components/page-layout";
import { WithPermissions } from "@/components/roles/with-permissions";
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
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth.query";
import {
  useConversation,
  useCreateConversation,
  useUpdateConversation,
} from "@/lib/chat.query";
import { useChatModelsQuery } from "@/lib/chat-models.query";
import {
  type SupportedChatProvider,
  useChatApiKeys,
} from "@/lib/chat-settings.query";
import { useDialogs } from "@/lib/dialog.hook";
import { useFeatures } from "@/lib/features.query";
import { useDeletePrompt, usePrompt, usePrompts } from "@/lib/prompts.query";
import ArchestraPromptInput from "./prompt-input";

const CONVERSATION_QUERY_PARAM = "conversation";

export default function ChatPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [conversationId, setConversationId] = useState<string | undefined>(
    () => searchParams.get(CONVERSATION_QUERY_PARAM) || undefined,
  );
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
  const userMessageJustEdited = useRef(false);

  // Dialog management for MCP installation
  const { isDialogOpened, openDialog, closeDialog } = useDialogs<
    "custom-request" | "create-catalog"
  >();

  // Check if user can create catalog items directly
  const { data: canCreateCatalog } = useHasPermissions({
    internalMcpCatalog: ["create"],
  });

  // State for prompt management
  const [isPromptDialogOpen, setIsPromptDialogOpen] = useState(false);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [versionHistoryPrompt, setVersionHistoryPrompt] = useState<
    (typeof prompts)[number] | null
  >(null);

  // Fetch prompts and current editing prompt
  const { data: prompts = [] } = usePrompts();
  const { data: editingPrompt } = usePrompt(editingPromptId || "");
  const deletePromptMutation = useDeletePrompt();
  const { data: allProfiles = [] } = useProfiles();

  const chatSession = useChatSession(conversationId);

  // Check if API key is configured for any provider
  const { data: chatApiKeys = [], isLoading: isLoadingApiKeys } =
    useChatApiKeys();
  const { data: features, isLoading: isLoadingFeatures } = useFeatures();
  const { data: chatModels = [] } = useChatModelsQuery(conversationId);
  // Vertex AI Gemini mode doesn't require an API key (uses ADC)
  const hasAnyApiKey =
    chatApiKeys.some((k) => k.secretId) || features?.geminiVertexAiEnabled;
  const isLoadingApiKeyCheck = isLoadingApiKeys || isLoadingFeatures;

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
  const { data: conversation, isLoading: isLoadingConversation } =
    useConversation(conversationId);

  // Derive current provider from selected model
  const currentProvider = useMemo((): SupportedChatProvider | undefined => {
    if (!conversation?.selectedModel) return undefined;
    const model = chatModels.find((m) => m.id === conversation.selectedModel);
    return model?.provider as SupportedChatProvider | undefined;
  }, [conversation?.selectedModel, chatModels]);

  // Mutation for updating conversation model
  const updateConversationMutation = useUpdateConversation();

  // Handle model change with error handling
  const handleModelChange = useCallback(
    (model: string) => {
      if (!conversation) return;

      updateConversationMutation.mutate(
        {
          id: conversation.id,
          selectedModel: model,
        },
        {
          onError: (error) => {
            toast.error(
              `Failed to change model: ${error instanceof Error ? error.message : "Unknown error"}`,
            );
          },
        },
      );
    },
    [conversation, updateConversationMutation],
  );

  // Find the specific prompt for this conversation (if any)
  const conversationPrompt = conversation?.promptId
    ? prompts.find((p) => p.id === conversation.promptId)
    : undefined;

  // Get current agent info
  const currentProfileId = conversation?.agentId;

  // Clear MCP Gateway sessions when opening a NEW conversation
  useEffect(() => {
    // Only clear sessions if this is a newly created conversation
    if (
      currentProfileId &&
      conversationId &&
      newlyCreatedConversationRef.current === conversationId
    ) {
      // Clear sessions for this agent to ensure fresh MCP state
      fetch("/v1/mcp/sessions", {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${currentProfileId}`,
        },
      })
        .then(async () => {
          // Clear the ref after clearing sessions
          newlyCreatedConversationRef.current = undefined;
        })
        .catch((error) => {
          console.error("[Chat] Failed to clear MCP sessions:", {
            conversationId,
            agentId: currentProfileId,
            error,
          });
          // Clear the ref even on error to avoid retry loops
          newlyCreatedConversationRef.current = undefined;
        });
    }
  }, [conversationId, currentProfileId]);

  // Create conversation mutation (requires agentId)
  const createConversationMutation = useCreateConversation();

  // Handle prompt selection from library
  const handleSelectPrompt = useCallback(
    async (agentId: string, promptId?: string) => {
      // If promptId is provided, fetch the prompt and use its userPrompt
      if (promptId) {
        const selectedPrompt = prompts.find((p) => p.id === promptId);
        if (selectedPrompt?.userPrompt) {
          pendingPromptRef.current = selectedPrompt.userPrompt;
        }
      }

      // Create conversation for the selected agent with optional promptId
      const newConversation = await createConversationMutation.mutateAsync({
        agentId,
        promptId,
      });
      if (newConversation) {
        // Mark this as a newly created conversation
        newlyCreatedConversationRef.current = newConversation.id;
        selectConversation(newConversation.id);
      }
    },
    [createConversationMutation, selectConversation, prompts],
  );

  const handleEditPrompt = useCallback((prompt: (typeof prompts)[number]) => {
    setEditingPromptId(prompt.id);
    setIsPromptDialogOpen(true);
  }, []);

  const handleCreatePrompt = useCallback(() => {
    setEditingPromptId(null);
    setIsPromptDialogOpen(true);
  }, []);

  // Listen for custom event from layout to open dialog
  useEffect(() => {
    const handleOpenDialog = () => {
      handleCreatePrompt();
    };
    window.addEventListener("open-prompt-dialog", handleOpenDialog);
    return () => {
      window.removeEventListener("open-prompt-dialog", handleOpenDialog);
    };
  }, [handleCreatePrompt]);

  const handleDeletePrompt = useCallback(
    async (promptId: string) => {
      try {
        await deletePromptMutation.mutateAsync(promptId);
      } catch (error) {
        console.error("Failed to delete prompt:", error);
      }
    },
    [deletePromptMutation],
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

    // Open the appropriate dialog based on user permissions
    if (canCreateCatalog) {
      openDialog("create-catalog");
    } else {
      openDialog("custom-request");
    }

    void (async () => {
      try {
        await addToolResult({
          tool: pendingCustomServerToolCall.toolName as never,
          toolCallId: pendingCustomServerToolCall.toolCallId,
          output: {
            type: "text",
            text: canCreateCatalog
              ? "Opening the Add MCP Server to Private Registry dialog."
              : "Opening the custom MCP server installation request dialog.",
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
    canCreateCatalog,
    openDialog,
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

    // Sync messages from backend only on initial load or when recovering from empty state
    // The AI SDK manages message state correctly during streaming, so we shouldn't overwrite it
    const shouldSync =
      conversation?.messages &&
      conversation.id === conversationId &&
      status !== "submitted" &&
      status !== "streaming" &&
      !userMessageJustEdited.current &&
      (loadedConversationRef.current !== conversationId ||
        messages.length === 0);

    if (shouldSync) {
      setMessages(conversation.messages as UIMessage[]);
      loadedConversationRef.current = conversationId;

      // If there's a pending prompt and the conversation is empty, send it
      if (pendingPromptRef.current && conversation.messages.length === 0) {
        const promptToSend = pendingPromptRef.current;
        pendingPromptRef.current = undefined;
        sendMessage({
          role: "user",
          parts: [{ type: "text", text: promptToSend }],
        });
      }
    }

    // Clear the edit flag when status changes to ready (streaming finished)
    if (status === "ready" && userMessageJustEdited.current) {
      userMessageJustEdited.current = false;
    }
  }, [
    conversationId,
    conversation,
    setMessages,
    sendMessage,
    status,
    messages.length,
  ]);

  // Merge database UUIDs from backend into local message state
  // This runs after streaming completes and backend query has fetched
  useEffect(() => {
    if (
      !setMessages ||
      !conversation?.messages ||
      conversation.id !== conversationId ||
      status === "streaming" ||
      status === "submitted"
    ) {
      return;
    }

    // Only merge IDs if backend has same or more messages than local state
    if (conversation.messages.length < messages.length) {
      return;
    }

    // Check if any message has a non-UUID ID that needs updating
    const needsIdUpdate = messages.some((localMsg, idx) => {
      const backendMsg = conversation.messages[idx] as UIMessage | undefined;
      return (
        backendMsg &&
        backendMsg.id !== localMsg.id &&
        // Check if backend ID looks like a UUID (has dashes)
        backendMsg.id.includes("-")
      );
    });

    if (!needsIdUpdate) {
      return;
    }

    // Merge IDs from backend into local messages
    const mergedMessages = messages.map((localMsg, idx) => {
      const backendMsg = conversation.messages[idx] as UIMessage | undefined;
      if (
        backendMsg &&
        backendMsg.id !== localMsg.id &&
        backendMsg.id.includes("-")
      ) {
        // Update only the ID, keep everything else from local state
        return { ...localMsg, id: backendMsg.id };
      }
      return localMsg;
    });

    setMessages(mergedMessages as UIMessage[]);
  }, [
    conversationId,
    conversation?.messages,
    conversation?.id,
    messages,
    setMessages,
    status,
  ]);

  const handleSubmit: PromptInputProps["onSubmit"] = (message, e) => {
    e.preventDefault();
    if (status === "submitted" || status === "streaming") {
      stop?.();
    }

    if (
      !sendMessage ||
      !message.text?.trim() ||
      status === "submitted" ||
      status === "streaming"
    ) {
      return;
    }

    sendMessage?.({
      role: "user",
      parts: [{ type: "text", text: message.text }],
    });
  };

  // If API key is not configured, show setup message
  // Only show after loading completes to avoid flash of incorrect content
  if (!isLoadingApiKeyCheck && !hasAnyApiKey) {
    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>LLM Provider API Key Required</CardTitle>
            <CardDescription>
              The chat feature requires an LLM provider API key to function.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Please configure an LLM provider API key in Chat Settings to start
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

  const profileName = conversationPrompt?.agentId
    ? allProfiles.find((a) => a.id === conversationPrompt.agentId)?.name
    : null;
  const promptBadge = (
    <>
      {conversationPrompt ? (
        <div className="flex items-center gap-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center px-2 py-1 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 text-xs font-medium cursor-help">
                  Prompt: {conversationPrompt.name}
                </span>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="max-w-md max-h-64 overflow-y-auto"
              >
                <div className="space-y-2">
                  {profileName && (
                    <div>
                      <div className="font-semibold text-xs mb-1">Profile:</div>
                      <div className="text-xs">{profileName}</div>
                    </div>
                  )}
                  {conversationPrompt.systemPrompt && (
                    <div>
                      <div className="font-semibold text-xs mb-1">
                        System Prompt:
                      </div>
                      <pre className="text-xs whitespace-pre-wrap">
                        {conversationPrompt.systemPrompt}
                      </pre>
                    </div>
                  )}
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      ) : null}
    </>
  );

  if (!conversationId) {
    const hasNoProfiles = allProfiles.length === 0;

    return (
      <PageLayout
        title="New Chat"
        description="Start a free chat or select a prompt from your library to start a guided chat"
        actionButton={
          <WithPermissions
            permissions={{ prompt: ["create"] }}
            noPermissionHandle="hide"
          >
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      onClick={handleCreatePrompt}
                      size="sm"
                      disabled={hasNoProfiles}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add Prompt
                    </Button>
                  </span>
                </TooltipTrigger>
                {hasNoProfiles && (
                  <TooltipContent>
                    <p>No profiles available</p>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          </WithPermissions>
        }
      >
        <PromptLibraryGrid
          prompts={prompts}
          onSelectPrompt={handleSelectPrompt}
          onEdit={handleEditPrompt}
          onDelete={handleDeletePrompt}
          onViewVersionHistory={setVersionHistoryPrompt}
        />
        <PromptDialog
          open={isPromptDialogOpen}
          onOpenChange={(open) => {
            setIsPromptDialogOpen(open);
            if (!open) {
              setEditingPromptId(null);
            }
          }}
          prompt={editingPrompt}
          onViewVersionHistory={setVersionHistoryPrompt}
        />
        <PromptVersionHistoryDialog
          open={!!versionHistoryPrompt}
          onOpenChange={(open) => {
            if (!open) {
              setVersionHistoryPrompt(null);
            }
          }}
          prompt={versionHistoryPrompt}
        />
      </PageLayout>
    );
  }

  return (
    <div className="flex h-screen w-full">
      <div className="flex-1 flex flex-col w-full">
        <div className="flex flex-col h-full">
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
            <div className="flex-1 flex justify-end gap-2 items-center">
              {promptBadge}
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
              conversationId={conversationId}
              messages={messages}
              hideToolCalls={hideToolCalls}
              status={status}
              isLoadingConversation={isLoadingConversation}
              onMessagesUpdate={setMessages}
              onUserMessageEdit={(
                editedMessage,
                updatedMessages,
                editedPartIndex,
              ) => {
                // After user message is edited, set messages WITHOUT the edited one, then send it fresh
                if (setMessages && sendMessage) {
                  // Set flag to prevent message sync from overwriting our state
                  userMessageJustEdited.current = true;

                  // Remove the edited message (last one) - we'll re-send it via sendMessage()
                  const messagesWithoutEditedMessage = updatedMessages.slice(
                    0,
                    -1,
                  );
                  setMessages(messagesWithoutEditedMessage);

                  // Send the edited message to generate new response (same as handleSubmit)
                  // Use the specific part that was edited (via editedPartIndex) instead of finding
                  // the first text part, in case the message has multiple text parts
                  const editedPart = editedMessage.parts?.[editedPartIndex];
                  const editedText =
                    editedPart?.type === "text" ? editedPart.text : "";
                  if (editedText?.trim()) {
                    sendMessage({
                      role: "user",
                      parts: [{ type: "text", text: editedText }],
                    });
                  }
                }
              }}
              error={error}
            />
          </div>

          {conversation?.agent.id && conversation?.id && (
            <div className="sticky bottom-0 bg-background border-t p-4">
              <div className="max-w-4xl mx-auto space-y-3">
                <ArchestraPromptInput
                  onSubmit={handleSubmit}
                  status={status}
                  selectedModel={conversation?.selectedModel ?? ""}
                  onModelChange={handleModelChange}
                  messageCount={messages.length}
                  agentId={conversation?.agent.id}
                  conversationId={conversation?.id}
                  currentConversationChatApiKeyId={conversation?.chatApiKeyId}
                  currentProvider={currentProvider}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <CustomServerRequestDialog
        isOpen={isDialogOpened("custom-request")}
        onClose={() => closeDialog("custom-request")}
      />
      <CreateCatalogDialog
        isOpen={isDialogOpened("create-catalog")}
        onClose={() => closeDialog("create-catalog")}
        onSuccess={() => router.push("/mcp-catalog/registry")}
      />
    </div>
  );
}
