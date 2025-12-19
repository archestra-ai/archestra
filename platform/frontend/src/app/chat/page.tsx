"use client";

import type { UIMessage } from "@ai-sdk/react";
import { ArrowRight, Eye, EyeOff, KeyRound, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { CreateCatalogDialog } from "@/app/mcp-catalog/_parts/create-catalog-dialog";
import { CustomServerRequestDialog } from "@/app/mcp-catalog/_parts/custom-server-request-dialog";
import { Loader } from "@/components/ai-elements/loader";
import {
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { ChatError } from "@/components/chat/chat-error";
import { ChatMessages } from "@/components/chat/chat-messages";
import { McpToolsDisplay } from "@/components/chat/mcp-tools-display";
import { ModelSelector } from "@/components/chat/model-selector";
import { PromptDialog } from "@/components/chat/prompt-dialog";
import { PromptLibraryGrid } from "@/components/chat/prompt-library-grid";
import { PromptVersionHistoryDialog } from "@/components/chat/prompt-version-history-dialog";
import { StreamTimeoutWarning } from "@/components/chat/stream-timeout-warning";
import { PageLayout } from "@/components/page-layout";
import { WithPermissions } from "@/components/roles/with-permissions";
import { Badge } from "@/components/ui/badge";
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
import { useChatApiKeys } from "@/lib/chat-settings.query";
import { useDialogs } from "@/lib/dialog.hook";
import { useFeatures } from "@/lib/features.query";
import { useDeletePrompt, usePrompt, usePrompts } from "@/lib/prompts.query";

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

  // Show loading state while checking API key configuration
  if (isLoadingApiKeyCheck) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Loader size={32} className="text-muted-foreground" />
      </div>
    );
  }

  // If API key is not configured, show setup message
  if (!hasAnyApiKey) {
    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            {/* Icon */}
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 border">
              <KeyRound className="h-6 w-6 text-primary" />
            </div>

            <CardTitle>Connect Your AI Provider</CardTitle>
          </CardHeader>

          <CardContent className="space-y-6">
            {/* Provider icons */}
            <div className="flex justify-center gap-6">
              {/* OpenAI */}
              <div className="flex flex-col items-center gap-1.5 group">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border bg-background group-hover:border-primary/50 transition-colors">
                  <svg
                    className="h-5 w-5"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    role="img"
                    aria-label="OpenAI logo"
                  >
                    <title>OpenAI</title>
                    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
                  </svg>
                </div>
                <span className="text-xs text-muted-foreground">OpenAI</span>
              </div>

              {/* Anthropic */}
              <div className="flex flex-col items-center gap-1.5 group">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border bg-background group-hover:border-primary/50 transition-colors">
                  <svg
                    className="h-5 w-5"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    role="img"
                    aria-label="Anthropic logo"
                  >
                    <title>Anthropic</title>
                    <path d="M17.304 3.541h-3.672l6.696 16.918h3.672l-6.696-16.918ZM6.696 3.541 0 20.459h3.672l1.344-3.541h6.792l1.344 3.541h3.672L10.128 3.541H6.696Zm-.576 10.459 2.208-5.812 2.208 5.812H6.12Z" />
                  </svg>
                </div>
                <span className="text-xs text-muted-foreground">Anthropic</span>
              </div>

              {/* Google Gemini */}
              <div className="flex flex-col items-center gap-1.5 group">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border bg-background group-hover:border-primary/50 transition-colors">
                  <svg
                    className="h-5 w-5"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    role="img"
                    aria-label="Google Gemini logo"
                  >
                    <title>Gemini</title>
                    <path d="M12 0L14.59 9.41L24 12L14.59 14.59L12 24L9.41 14.59L0 12L9.41 9.41L12 0Z" />
                  </svg>
                </div>
                <span className="text-xs text-muted-foreground">Gemini</span>
              </div>
            </div>

            {/* Description */}
            <p className="text-sm text-muted-foreground text-center">
              Configure your preferred AI provider in settings to start using
              the chat feature.
            </p>

            {/* CTA Button */}
            <Button asChild className="w-full">
              <Link
                href="/settings/chat"
                className="flex items-center justify-center gap-2"
              >
                Configure API Keys
                <ArrowRight className="h-4 w-4" />
              </Link>
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
          {error && <ChatError error={error} />}
          <StreamTimeoutWarning status={status} messages={messages} />

          <div className="sticky top-0 z-10 bg-background border-b p-2 flex items-center justify-between">
            <div className="flex-1 flex items-center gap-2">
              {conversation && (
                <ModelSelector
                  selectedModel={conversation.selectedModel}
                  onModelChange={handleModelChange}
                  disabled={status === "streaming" || status === "submitted"}
                  messageCount={messages.length}
                />
              )}
            </div>
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
              messages={messages}
              hideToolCalls={hideToolCalls}
              status={status}
              isLoadingConversation={isLoadingConversation}
            />
          </div>

          <div className="sticky bottom-0 bg-background border-t p-4">
            <div className="max-w-3xl mx-auto space-y-3">
              {currentProfileId && (
                <WithPermissions
                  permissions={{ profile: ["read"] }}
                  noPermissionHandle="tooltip"
                >
                  {({ hasPermission }) => {
                    return hasPermission ===
                      undefined ? null : hasPermission ? (
                      <McpToolsDisplay
                        agentId={currentProfileId}
                        className="text-xs text-muted-foreground"
                      />
                    ) : (
                      <Badge variant="outline" className="text-xs my-2">
                        Unable to show the list of tools
                      </Badge>
                    );
                  }}
                </WithPermissions>
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
