"use client";

import type { UIMessage } from "@ai-sdk/react";
import { Eye, EyeOff, FileText, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { CreateCatalogDialog } from "@/app/mcp-catalog/_parts/create-catalog-dialog";
import { CustomServerRequestDialog } from "@/app/mcp-catalog/_parts/custom-server-request-dialog";
import { Message, MessageContent } from "@/components/ai-elements/message";
import type { PromptInputProps } from "@/components/ai-elements/prompt-input";
import { Response } from "@/components/ai-elements/response";
import { AgentSelector } from "@/components/chat/agent-selector";
import { AgentToolsDisplay } from "@/components/chat/agent-tools-display";
import { ChatMessages } from "@/components/chat/chat-messages";
import { ConversationArtifactPanel } from "@/components/chat/conversation-artifact";
import { InitialAgentSelector } from "@/components/chat/initial-agent-selector";
import { PromptDialog } from "@/components/chat/prompt-dialog";
import { PromptVersionHistoryDialog } from "@/components/chat/prompt-version-history-dialog";
import { StreamTimeoutWarning } from "@/components/chat/stream-timeout-warning";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Version } from "@/components/version";
import { useChatSession } from "@/contexts/global-chat-context";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth.query";
import {
  useConversation,
  useCreateConversation,
  useUpdateConversation,
} from "@/lib/chat.query";
import {
  useChatModelsQuery,
  useModelsByProvider,
} from "@/lib/chat-models.query";
import {
  type SupportedChatProvider,
  useChatApiKeys,
} from "@/lib/chat-settings.query";
import { useDialogs } from "@/lib/dialog.hook";
import { useFeatures } from "@/lib/features.query";
import { usePrompt, usePrompts } from "@/lib/prompts.query";
import ArchestraPromptInput from "./prompt-input";

const CONVERSATION_QUERY_PARAM = "conversation";

export default function ChatPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [conversationId, setConversationId] = useState<string | undefined>(
    () => searchParams.get(CONVERSATION_QUERY_PARAM) || undefined,
  );

  // Hide version display from layout - chat page has its own version display
  useEffect(() => {
    document.body.classList.add("hide-version");
    return () => document.body.classList.remove("hide-version");
  }, []);
  const [hideToolCalls, setHideToolCalls] = useState(() => {
    // Initialize from localStorage
    if (typeof window !== "undefined") {
      return localStorage.getItem("archestra-chat-hide-tool-calls") === "true";
    }
    return false;
  });
  const [isArtifactOpen, setIsArtifactOpen] = useState(() => {
    // Initialize artifact panel state from localStorage
    if (typeof window !== "undefined") {
      return localStorage.getItem("archestra-chat-artifact-open") === "true";
    }
    return false;
  });
  const loadedConversationRef = useRef<string | undefined>(undefined);
  const pendingPromptRef = useRef<string | undefined>(undefined);
  const newlyCreatedConversationRef = useRef<string | undefined>(undefined);
  const userMessageJustEdited = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Dialog management for MCP installation
  const { isDialogOpened, openDialog, closeDialog } = useDialogs<
    "custom-request" | "create-catalog"
  >();

  // Check if user can create catalog items directly
  const { data: canCreateCatalog } = useHasPermissions({
    internalMcpCatalog: ["create"],
  });

  // Fetch prompts for conversation prompt name lookup
  const { data: prompts = [] } = usePrompts();

  // Fetch profiles and models for initial chat (no conversation)
  const { data: allProfiles = [] } = useProfiles();
  const { modelsByProvider } = useModelsByProvider();

  // State for initial chat (when no conversation exists yet)
  const [initialAgentId, setInitialAgentId] = useState<string | null>(null);
  const [initialPromptId, setInitialPromptId] = useState<string | null>(null);
  const [initialModel, setInitialModel] = useState<string>("");
  const [initialApiKeyId, setInitialApiKeyId] = useState<string | null>(null);

  // Prompt edit dialog state
  const [isPromptDialogOpen, setIsPromptDialogOpen] = useState(false);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [versionHistoryPrompt, setVersionHistoryPrompt] = useState<
    (typeof prompts)[number] | null
  >(null);
  const { data: editingPrompt } = usePrompt(editingPromptId || "");

  // Set default initial agent and model when data loads
  useEffect(() => {
    if (!initialAgentId && allProfiles.length > 0) {
      setInitialAgentId(allProfiles[0].id);
    }
  }, [allProfiles, initialAgentId]);

  useEffect(() => {
    if (!initialModel) {
      const providers = Object.keys(modelsByProvider);
      if (providers.length > 0) {
        const firstProvider = providers[0];
        const models =
          modelsByProvider[firstProvider as keyof typeof modelsByProvider];
        if (models && models.length > 0) {
          setInitialModel(models[0].id);
        }
      }
    }
  }, [modelsByProvider, initialModel]);

  // Derive provider from initial model for API key filtering
  const initialProvider = useMemo((): SupportedChatProvider | undefined => {
    if (!initialModel) return undefined;
    for (const [provider, models] of Object.entries(modelsByProvider)) {
      if (models?.some((m) => m.id === initialModel)) {
        return provider as SupportedChatProvider;
      }
    }
    return undefined;
  }, [initialModel, modelsByProvider]);

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

  // Handle provider change for existing conversation - switch to first model of new provider
  const handleProviderChange = useCallback(
    (provider: SupportedChatProvider) => {
      const models = modelsByProvider[provider];
      if (models && models.length > 0) {
        handleModelChange(models[0].id);
      }
    },
    [modelsByProvider, handleModelChange],
  );

  // Handle provider change for initial chat - switch to first model of new provider
  const handleInitialProviderChange = useCallback(
    (provider: SupportedChatProvider) => {
      const models = modelsByProvider[provider];
      if (models && models.length > 0) {
        setInitialModel(models[0].id);
      }
    },
    [modelsByProvider],
  );

  // Find the specific prompt for this conversation (if any)
  const _conversationPrompt = conversation?.promptId
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

  // Persist hide tool calls preference
  const toggleHideToolCalls = useCallback(() => {
    const newValue = !hideToolCalls;
    setHideToolCalls(newValue);
    localStorage.setItem("archestra-chat-hide-tool-calls", String(newValue));
  }, [hideToolCalls]);

  // Persist artifact panel state
  const toggleArtifactPanel = useCallback(() => {
    const newValue = !isArtifactOpen;
    setIsArtifactOpen(newValue);
    localStorage.setItem("archestra-chat-artifact-open", String(newValue));
  }, [isArtifactOpen]);

  // Auto-open artifact panel when artifact is updated
  const previousArtifactRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // Only auto-open if:
    // 1. We have a conversation with an artifact
    // 2. The artifact has changed (not just initial load)
    // 3. The panel is currently closed
    if (
      conversation?.artifact &&
      previousArtifactRef.current !== undefined && // Not the initial render
      previousArtifactRef.current !== conversation.artifact &&
      !isArtifactOpen
    ) {
      setIsArtifactOpen(true);
      localStorage.setItem("archestra-chat-artifact-open", "true");
    }

    // Update the ref for next comparison
    previousArtifactRef.current = conversation?.artifact;
  }, [conversation?.artifact, isArtifactOpen]);

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

  // Auto-focus textarea when status becomes ready (message sent or stream finished)
  // or when conversation loads (e.g., new chat created, hard refresh)
  useLayoutEffect(() => {
    if (status === "ready" && conversation?.id && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [status, conversation?.id]);

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

  // Handle initial prompt change (when no conversation exists)
  const handleInitialPromptChange = useCallback(
    (promptId: string | null, agentId: string) => {
      setInitialAgentId(agentId);
      setInitialPromptId(promptId);
    },
    [],
  );

  // Handle initial submit (when no conversation exists)
  const handleInitialSubmit: PromptInputProps["onSubmit"] = useCallback(
    (message, e) => {
      e.preventDefault();
      if (
        !message.text?.trim() ||
        !initialAgentId ||
        !initialModel ||
        createConversationMutation.isPending
      ) {
        return;
      }

      // Store the message to send after conversation is created
      pendingPromptRef.current = message.text;

      // Create conversation with the selected agent and prompt
      createConversationMutation.mutate(
        {
          agentId: initialAgentId,
          selectedModel: initialModel,
          promptId: initialPromptId ?? undefined,
          chatApiKeyId: initialApiKeyId,
        },
        {
          onSuccess: (newConversation) => {
            if (newConversation) {
              newlyCreatedConversationRef.current = newConversation.id;
              selectConversation(newConversation.id);
              toast.success("Conversation created");
            }
          },
        },
      );
    },
    [
      initialAgentId,
      initialPromptId,
      initialModel,
      initialApiKeyId,
      createConversationMutation,
      selectConversation,
    ],
  );

  // Determine which agent ID to use for prompt input
  const activeAgentId = conversationId
    ? conversation?.agent?.id
    : initialAgentId;

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
              Please configure an LLM provider API key to start using the chat
              feature.
            </p>
            <Button asChild>
              <Link href="/settings/llm-api-keys">Go to LLM API Keys</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full">
      <div className="flex-1 flex flex-col w-full">
        <div className="flex flex-col h-full">
          <StreamTimeoutWarning status={status} messages={messages} />

          <div className="sticky top-0 z-10 bg-background border-b p-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              {/* Agent/Profile selector */}
              {conversationId ? (
                <AgentSelector
                  currentPromptId={conversation?.promptId ?? null}
                  currentAgentId={conversation?.agentId ?? ""}
                  currentModel={conversation?.selectedModel ?? ""}
                />
              ) : (
                <InitialAgentSelector
                  currentPromptId={initialPromptId}
                  onPromptChange={handleInitialPromptChange}
                  defaultAgentId={initialAgentId ?? allProfiles[0]?.id ?? ""}
                />
              )}

              {/* Single AgentToolsDisplay instance - no remounting */}
              {/* Use stable promptId that doesn't change during conversation creation */}
              {(initialPromptId || conversation?.promptId) && (
                <>
                  <AgentToolsDisplay
                    promptId={conversation?.promptId ?? initialPromptId}
                    conversationId={conversationId}
                    onCreateConversation={
                      conversationId
                        ? undefined
                        : () => {
                            // Create conversation when user toggles an agent
                            if (!initialAgentId || !initialModel) return;
                            createConversationMutation.mutate(
                              {
                                agentId: initialAgentId,
                                selectedModel: initialModel,
                                promptId: initialPromptId ?? undefined,
                                chatApiKeyId: initialApiKeyId,
                              },
                              {
                                onSuccess: (newConversation) => {
                                  if (newConversation) {
                                    newlyCreatedConversationRef.current =
                                      newConversation.id;
                                    selectConversation(newConversation.id);
                                    toast.success("Conversation created");
                                  }
                                },
                              },
                            );
                          }
                    }
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 gap-1.5 text-xs border-dashed"
                    onClick={() => {
                      const promptIdToEdit =
                        conversation?.promptId ?? initialPromptId;
                      if (promptIdToEdit) {
                        setEditingPromptId(promptIdToEdit);
                        setIsPromptDialogOpen(true);
                      }
                    }}
                  >
                    <Plus className="h-3 w-3" />
                    Add agents
                  </Button>
                </>
              )}
            </div>
            <div className="flex gap-2 items-center">
              {!isArtifactOpen && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleArtifactPanel}
                  className="text-xs"
                >
                  <FileText className="h-3 w-3 mr-1" />
                  Show Artifact
                </Button>
              )}
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
            {conversationId ? (
              <ChatMessages
                conversationId={conversationId}
                agentId={currentProfileId}
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
            ) : (
              <div className="flex items-center justify-center h-full">
                <div className="text-center space-y-6 max-w-2xl px-4">
                  {initialPromptId ? (
                    // Agent selected - show prompt
                    (() => {
                      const selectedPrompt = prompts.find(
                        (p) => p.id === initialPromptId,
                      );

                      return (
                        <>
                          <p className="text-lg text-muted-foreground">
                            To start conversation with{" "}
                            <span className="font-medium text-foreground">
                              {selectedPrompt?.name}
                            </span>{" "}
                            {selectedPrompt?.userPrompt
                              ? "select a prompt or start typing below"
                              : "start typing below"}
                          </p>
                          {selectedPrompt?.userPrompt && (
                            <button
                              type="button"
                              onClick={() => {
                                const userPrompt = selectedPrompt.userPrompt;
                                if (!userPrompt) return;
                                const syntheticEvent = {
                                  preventDefault: () => {},
                                } as React.FormEvent<HTMLFormElement>;
                                handleInitialSubmit(
                                  { text: userPrompt, files: [] },
                                  syntheticEvent,
                                );
                              }}
                              className="w-full text-left cursor-pointer hover:opacity-80 transition-opacity"
                            >
                              <Message
                                from="assistant"
                                className="max-w-none justify-center"
                              >
                                <MessageContent className="max-w-none text-center">
                                  <Response>
                                    {selectedPrompt.userPrompt}
                                  </Response>
                                </MessageContent>
                              </Message>
                            </button>
                          )}
                          <p className="text-sm text-muted-foreground">
                            <button
                              type="button"
                              onClick={() =>
                                handleInitialPromptChange(
                                  null,
                                  allProfiles[0]?.id ?? "",
                                )
                              }
                              className="underline hover:text-foreground"
                            >
                              back to agent selection
                            </button>
                          </p>
                        </>
                      );
                    })()
                  ) : (
                    // No agent selected - show agent list
                    <>
                      <p className="text-lg text-muted-foreground">
                        {prompts.length > 0
                          ? "To start conversation select an agent or start typing below"
                          : "To start conversation start typing below"}
                      </p>
                      {prompts.length > 0 ? (
                        <div className="flex flex-wrap justify-center gap-2">
                          {prompts.map((prompt) => (
                            <Button
                              key={prompt.id}
                              variant="outline"
                              size="sm"
                              className="h-8 px-3 text-sm"
                              onClick={() =>
                                handleInitialPromptChange(
                                  prompt.id,
                                  prompt.agentId,
                                )
                              }
                            >
                              {prompt.name}
                            </Button>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingPromptId(null);
                              setIsPromptDialogOpen(true);
                            }}
                            className="underline hover:text-foreground"
                          >
                            create agent
                          </button>
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {activeAgentId && (
            <div className="sticky bottom-0 bg-background border-t p-4">
              <div className="max-w-4xl mx-auto space-y-3">
                {conversationId && conversation?.agent.id ? (
                  <ArchestraPromptInput
                    onSubmit={handleSubmit}
                    status={status}
                    selectedModel={conversation?.selectedModel ?? ""}
                    onModelChange={handleModelChange}
                    messageCount={messages.length}
                    agentId={conversation.agent.id}
                    conversationId={conversationId}
                    currentConversationChatApiKeyId={conversation?.chatApiKeyId}
                    currentProvider={currentProvider}
                    onProviderChange={handleProviderChange}
                    textareaRef={textareaRef}
                  />
                ) : (
                  <ArchestraPromptInput
                    onSubmit={handleInitialSubmit}
                    status={
                      createConversationMutation.isPending
                        ? "submitted"
                        : "ready"
                    }
                    selectedModel={initialModel}
                    onModelChange={setInitialModel}
                    agentId={activeAgentId}
                    onProfileChange={setInitialAgentId}
                    currentProvider={initialProvider}
                    initialApiKeyId={initialApiKeyId}
                    onApiKeyChange={setInitialApiKeyId}
                    onProviderChange={handleInitialProviderChange}
                    onCreateConversation={() => {
                      // Create conversation when user interacts with tools
                      if (!initialAgentId || !initialModel) return;
                      createConversationMutation.mutate(
                        {
                          agentId: initialAgentId,
                          selectedModel: initialModel,
                          promptId: initialPromptId ?? undefined,
                          chatApiKeyId: initialApiKeyId,
                        },
                        {
                          onSuccess: (newConversation) => {
                            if (newConversation) {
                              newlyCreatedConversationRef.current =
                                newConversation.id;
                              selectConversation(newConversation.id);
                              toast.success("Conversation created");
                            }
                          },
                        },
                      );
                    }}
                  />
                )}
                <div className="text-center">
                  <Version inline />
                </div>
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

      {/* Right-side artifact panel */}
      <ConversationArtifactPanel
        artifact={conversation?.artifact}
        isOpen={isArtifactOpen}
        onToggle={toggleArtifactPanel}
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
    </div>
  );
}
