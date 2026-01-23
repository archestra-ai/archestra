"use client";

import type { UIMessage } from "@ai-sdk/react";
import { Eye, EyeOff, FileText, Globe, PanelRightClose } from "lucide-react";
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
import { AgentDialog } from "@/components/agent-dialog";
import { Message, MessageContent } from "@/components/ai-elements/message";
import type { PromptInputProps } from "@/components/ai-elements/prompt-input";
import { Response } from "@/components/ai-elements/response";
import { AgentSelector } from "@/components/chat/agent-selector";
import { BrowserPanel } from "@/components/chat/browser-panel";
import { ChatMessages } from "@/components/chat/chat-messages";
import { ConversationArtifactPanel } from "@/components/chat/conversation-artifact";
import { InitialAgentSelector } from "@/components/chat/initial-agent-selector";
import { PromptVersionHistoryDialog } from "@/components/chat/prompt-version-history-dialog";
import { StreamTimeoutWarning } from "@/components/chat/stream-timeout-warning";
import { PermissivePolicyBar } from "@/components/permissive-policy-bar";
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
import {
  useInternalAgents,
  useProfile,
  useProfilesQuery,
} from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth.query";
import {
  useConversation,
  useCreateConversation,
  useHasPlaywrightMcpTools,
  useUpdateConversation,
  useUpdateConversationEnabledTools,
} from "@/lib/chat.query";
import {
  useChatModelsQuery,
  useModelsByProviderQuery,
} from "@/lib/chat-models.query";
import {
  type SupportedChatProvider,
  useChatApiKeys,
} from "@/lib/chat-settings.query";
import { useDialogs } from "@/lib/dialog.hook";
import { useFeatureFlag } from "@/lib/features.hook";
import { useFeatures } from "@/lib/features.query";
import { useOrganization } from "@/lib/organization.query";
import {
  applyPendingActions,
  clearPendingActions,
  getPendingActions,
} from "@/lib/pending-tool-state";
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
  const pendingFilesRef = useRef<
    Array<{ url: string; mediaType: string; filename?: string }>
  >([]);
  const newlyCreatedConversationRef = useRef<string | undefined>(undefined);
  const userMessageJustEdited = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const autoSendTriggeredRef = useRef(false);

  // Dialog management for MCP installation
  const { isDialogOpened, openDialog, closeDialog } = useDialogs<
    "custom-request" | "create-catalog"
  >();

  // Check if user can create catalog items directly
  const { data: canCreateCatalog } = useHasPermissions({
    internalMcpCatalog: ["create"],
  });

  // State for browser panel
  const [isBrowserPanelOpen, setIsBrowserPanelOpen] = useState(false);

  // Fetch internal agents for dialog editing
  const { data: internalAgents = [] } = useInternalAgents();

  // Fetch profiles and models for initial chat (no conversation)
  // Using non-suspense queries to avoid blocking page render
  const { data: allProfiles = [] } = useProfilesQuery();
  const { modelsByProvider, isLoading: isModelsLoading } =
    useModelsByProviderQuery();

  // State for initial chat (when no conversation exists yet)
  const [initialAgentId, setInitialAgentId] = useState<string | null>(null);
  const [initialPromptId, setInitialPromptId] = useState<string | null>(null);
  const [initialModel, setInitialModel] = useState<string>("");
  const [initialApiKeyId, setInitialApiKeyId] = useState<string | null>(null);
  // Track if URL params have been consumed (so we don't re-apply them after user clears selection)
  const urlParamsConsumedRef = useRef(false);

  // Agent edit dialog state
  const [isAgentDialogOpen, setIsAgentDialogOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [versionHistoryAgent, setVersionHistoryAgent] = useState<
    (typeof internalAgents)[number] | null
  >(null);
  const { data: editingAgent } = useProfile(editingAgentId ?? undefined);

  // Set initial agent from URL param or default when data loads
  useEffect(() => {
    if (allProfiles.length === 0) return;

    // Only process URL params once (don't re-apply after user clears selection)
    if (!urlParamsConsumedRef.current) {
      // Check for promptId in URL query params (e.g., from /agents canvas "Chat" button)
      // With migration, promptId now refers to internal agent ID
      const urlPromptId = searchParams.get("promptId");
      if (urlPromptId) {
        const matchingAgent = internalAgents.find((a) => a.id === urlPromptId);
        if (matchingAgent) {
          setInitialPromptId(urlPromptId);
          setInitialAgentId(urlPromptId); // Internal agent IS the profile
          urlParamsConsumedRef.current = true;
          return;
        }
      }

      // Check for agentId in URL query params (legacy support)
      const urlAgentId = searchParams.get("agentId");
      if (urlAgentId) {
        const matchingProfile = allProfiles.find((p) => p.id === urlAgentId);
        if (matchingProfile) {
          setInitialAgentId(urlAgentId);
          // Check if this is an internal agent
          const internalAgent = internalAgents.find((a) => a.id === urlAgentId);
          if (internalAgent) {
            setInitialPromptId(urlAgentId);
          }
          urlParamsConsumedRef.current = true;
          return;
        }
      }
    }

    // Default to first profile if no initialAgentId set
    if (!initialAgentId) {
      setInitialAgentId(allProfiles[0].id);
    }
  }, [allProfiles, initialAgentId, searchParams, internalAgents]);

  // Initialize model from localStorage or default to first available
  useEffect(() => {
    if (!initialModel) {
      const allModels = Object.values(modelsByProvider).flat();
      if (allModels.length === 0) return;

      // Try to restore from localStorage
      const savedModelId = localStorage.getItem("selected-chat-model");
      if (savedModelId && allModels.some((m) => m.id === savedModelId)) {
        setInitialModel(savedModelId);
        return;
      }

      // Fall back to first available model
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

  // Save model to localStorage when changed
  const handleInitialModelChange = useCallback((modelId: string) => {
    setInitialModel(modelId);
    localStorage.setItem("selected-chat-model", modelId);
  }, []);

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
  const { data: organization } = useOrganization();
  const { data: chatModels = [] } = useChatModelsQuery();
  // Vertex AI Gemini mode doesn't require an API key (uses ADC)
  // vLLM/Ollama may not require an API key either
  const hasAnyApiKey =
    chatApiKeys.some((k) => k.secretId) ||
    features?.geminiVertexAiEnabled ||
    features?.vllmEnabled;
  const isLoadingApiKeyCheck = isLoadingApiKeys || isLoadingFeatures;

  // Sync conversation ID with URL and reset initial state when navigating to base /chat
  useEffect(() => {
    // Normalize null to undefined for consistent comparison
    const conversationParam =
      searchParams.get(CONVERSATION_QUERY_PARAM) ?? undefined;
    if (conversationParam !== conversationId) {
      setConversationId(conversationParam);

      // Reset initial state when navigating to /chat without a conversation
      // This ensures a fresh state when user clicks "New chat" or navigates back
      if (!conversationParam) {
        setInitialPromptId(null);
        // Reset initialAgentId to trigger re-selection from useEffect
        setInitialAgentId(null);
      }

      // Focus textarea after navigation (e.g., from search dialog)
      // Use requestAnimationFrame to ensure DOM is ready
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  }, [searchParams, conversationId]);

  // Get user_prompt from URL for auto-sending
  const initialUserPrompt = useMemo(() => {
    return searchParams.get("user_prompt") || undefined;
  }, [searchParams]);

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

      // Find the provider for this model
      const modelInfo = chatModels.find((m) => m.id === model);
      const provider = modelInfo?.provider as SupportedChatProvider | undefined;

      updateConversationMutation.mutate(
        {
          id: conversation.id,
          selectedModel: model,
          selectedProvider: provider,
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
    [conversation, chatModels, updateConversationMutation],
  );

  // Find the specific internal agent for this conversation (if any)
  const _conversationInternalAgent = conversation?.agentId
    ? internalAgents.find((a) => a.id === conversation.agentId)
    : undefined;

  // Get current agent info
  const currentProfileId = conversation?.agentId;
  const browserToolsAgentId = conversationId
    ? (conversation?.agentId ?? conversation?.agent?.id)
    : (initialAgentId ?? undefined);

  // Check if Playwright MCP is available for browser panel
  const hasPlaywrightMcp = useHasPlaywrightMcpTools(browserToolsAgentId);

  // Check if browser streaming feature is enabled
  const isBrowserStreamingEnabled = useFeatureFlag("browserStreamingEnabled");

  // Close browser panel when switching to a profile without Playwright tools
  useEffect(() => {
    if (!hasPlaywrightMcp && isBrowserPanelOpen) {
      setIsBrowserPanelOpen(false);
    }
  }, [hasPlaywrightMcp, isBrowserPanelOpen]);

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

  // Update enabled tools mutation (for applying pending actions)
  const updateEnabledToolsMutation = useUpdateConversationEnabledTools();

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

      // If there's a pending prompt/files and the conversation is empty, send it
      if (
        (pendingPromptRef.current || pendingFilesRef.current.length > 0) &&
        conversation.messages.length === 0
      ) {
        const promptToSend = pendingPromptRef.current;
        const filesToSend = pendingFilesRef.current;
        pendingPromptRef.current = undefined;
        pendingFilesRef.current = [];

        // Build message parts
        const parts: Array<
          | { type: "text"; text: string }
          | { type: "file"; url: string; mediaType: string; filename?: string }
        > = [];

        if (promptToSend) {
          parts.push({ type: "text", text: promptToSend });
        }

        for (const file of filesToSend) {
          parts.push({
            type: "file",
            url: file.url,
            mediaType: file.mediaType,
            filename: file.filename,
          });
        }

        sendMessage({
          role: "user",
          parts,
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

    const hasText = message.text?.trim();
    const hasFiles = message.files && message.files.length > 0;

    if (
      !sendMessage ||
      (!hasText && !hasFiles) ||
      status === "submitted" ||
      status === "streaming"
    ) {
      return;
    }

    // Build message parts: text first, then file attachments
    const parts: Array<
      | { type: "text"; text: string }
      | { type: "file"; url: string; mediaType: string; filename?: string }
    > = [];

    if (hasText) {
      parts.push({ type: "text", text: message.text as string });
    }

    // Add file parts
    if (hasFiles) {
      for (const file of message.files) {
        parts.push({
          type: "file",
          url: file.url,
          mediaType: file.mediaType,
          filename: file.filename,
        });
      }
    }

    sendMessage?.({
      role: "user",
      parts,
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
      const hasText = message.text?.trim();
      const hasFiles = message.files && message.files.length > 0;

      if (
        (!hasText && !hasFiles) ||
        !initialAgentId ||
        // !initialModel ||
        createConversationMutation.isPending
      ) {
        return;
      }

      // Store the message (text and files) to send after conversation is created
      pendingPromptRef.current = message.text || "";
      pendingFilesRef.current = message.files || [];

      // Check if there are pending tool actions to apply
      const pendingActions = getPendingActions(
        initialAgentId,
        initialPromptId ?? null,
      );

      // Find the provider for the initial model
      const modelInfo = chatModels.find((m) => m.id === initialModel);
      const selectedProvider = modelInfo?.provider as
        | SupportedChatProvider
        | undefined;

      // Create conversation with the selected agent and prompt
      createConversationMutation.mutate(
        {
          agentId: initialAgentId,
          selectedModel: initialModel,
          selectedProvider,
          chatApiKeyId: initialApiKeyId,
        },
        {
          onSuccess: async (newConversation) => {
            if (newConversation) {
              // Apply pending tool actions if any
              if (pendingActions.length > 0) {
                // Get the default enabled tools from the conversation (backend sets these)
                // We need to fetch them first to apply our pending actions on top
                try {
                  // The backend creates conversation with default enabled tools
                  // We need to apply pending actions to modify that default
                  const response = await fetch(
                    `/api/chat/conversations/${newConversation.id}/enabled-tools`,
                  );
                  if (response.ok) {
                    const data = await response.json();
                    const baseEnabledToolIds = data.enabledToolIds || [];
                    const newEnabledToolIds = applyPendingActions(
                      baseEnabledToolIds,
                      pendingActions,
                    );

                    // Update the enabled tools
                    updateEnabledToolsMutation.mutate({
                      conversationId: newConversation.id,
                      toolIds: newEnabledToolIds,
                    });
                  }
                } catch {
                  // Silently fail - the default tools will be used
                }
                // Clear pending actions regardless of success
                clearPendingActions();
              }

              newlyCreatedConversationRef.current = newConversation.id;
              selectConversation(newConversation.id);
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
      chatModels,
      createConversationMutation,
      updateEnabledToolsMutation,
      selectConversation,
    ],
  );

  // Auto-send message from URL when conditions are met (deep link support)
  useEffect(() => {
    // Skip if already triggered or no user_prompt in URL
    if (autoSendTriggeredRef.current || !initialUserPrompt) return;

    // Skip if conversation already exists
    if (conversationId) return;

    // Wait for agent to be ready.
    if (!initialAgentId) return;

    // Skip if mutation is already in progress
    if (createConversationMutation.isPending) return;

    // Mark as triggered to prevent duplicate sends
    autoSendTriggeredRef.current = true;

    // Store the message to send after conversation is created
    pendingPromptRef.current = initialUserPrompt;

    // Find the provider for the initial model
    const modelInfo = chatModels.find((m) => m.id === initialModel);
    const selectedProvider = modelInfo?.provider as
      | SupportedChatProvider
      | undefined;

    // Create conversation and send message
    createConversationMutation.mutate(
      {
        agentId: initialAgentId,
        selectedModel: initialModel,
        selectedProvider,
        chatApiKeyId: initialApiKeyId,
      },
      {
        onSuccess: (newConversation) => {
          if (newConversation) {
            newlyCreatedConversationRef.current = newConversation.id;
            selectConversation(newConversation.id);
          }
        },
      },
    );
  }, [
    initialUserPrompt,
    conversationId,
    initialAgentId,
    initialModel,
    initialApiKeyId,
    chatModels,
    createConversationMutation,
    selectConversation,
  ]);

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

  // If conversation ID is provided but conversation is not found (404)
  if (conversationId && !isLoadingConversation && !conversation) {
    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Conversation not found</CardTitle>
            <CardDescription>
              This conversation doesn&apos;t exist or you don&apos;t have access
              to it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              The conversation may have been deleted, or you may not have
              permission to view it.
            </p>
            <Button asChild>
              <Link href="/chat">Start a new chat</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full">
      <span id="chunk-test" style={{ visibility: "hidden" }}>
        {" "}
      </span>
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex flex-col h-full">
          <StreamTimeoutWarning status={status} messages={messages} />
          <PermissivePolicyBar />

          <div className="sticky top-0 z-10 bg-background border-b p-2">
            <div className="flex items-start justify-between gap-2">
              {/* Left side - agent selector stays fixed, tools wrap internally */}
              <div className="flex items-start gap-2 min-w-0 flex-1">
                {/* Agent/Profile selector - fixed width */}
                <div className="flex-shrink-0">
                  {conversationId ? (
                    <AgentSelector
                      currentPromptId={
                        conversation?.agent?.agentType === "agent"
                          ? (conversation?.agentId ?? null)
                          : null
                      }
                      currentAgentId={conversation?.agentId ?? ""}
                      currentModel={conversation?.selectedModel ?? ""}
                    />
                  ) : (
                    <InitialAgentSelector
                      currentPromptId={initialPromptId}
                      onPromptChange={handleInitialPromptChange}
                      defaultAgentId={
                        initialAgentId ?? allProfiles[0]?.id ?? ""
                      }
                    />
                  )}
                </div>
              </div>
              {/* Right side - controls stay fixed in first row */}
              <div className="flex items-center gap-2 flex-shrink-0">
                {hasPlaywrightMcp && isBrowserStreamingEnabled && (
                  <Button
                    variant={isBrowserPanelOpen ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => setIsBrowserPanelOpen(!isBrowserPanelOpen)}
                    className="text-xs"
                  >
                    <Globe className="h-3 w-3 mr-1" />
                    Browser
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleArtifactPanel}
                  className="text-xs"
                >
                  {isArtifactOpen ? (
                    <PanelRightClose className="h-3 w-3 mr-1" />
                  ) : (
                    <FileText className="h-3 w-3 mr-1" />
                  )}
                  {isArtifactOpen ? "Hide Artifact" : "Show Artifact"}
                </Button>
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
                  {initialPromptId
                    ? // Agent selected - show prompt
                      (() => {
                        const selectedAgent = internalAgents.find(
                          (a) => a.id === initialPromptId,
                        );

                        return (
                          <>
                            <p className="text-lg text-muted-foreground">
                              To start conversation with{" "}
                              <span className="font-medium text-foreground">
                                {selectedAgent?.name}
                              </span>{" "}
                              start typing below
                            </p>
                            {selectedAgent?.userPrompt && (
                              <button
                                type="button"
                                onClick={() => {
                                  const userPrompt = selectedAgent.userPrompt;
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
                                      {selectedAgent.userPrompt}
                                    </Response>
                                  </MessageContent>
                                </Message>
                              </button>
                            )}
                          </>
                        );
                      })()
                    : null}
                </div>
              </div>
            )}
          </div>

          {activeAgentId && (
            <div className="sticky bottom-0 bg-background border-t p-4">
              <div className="max-w-4xl mx-auto space-y-3">
                <ArchestraPromptInput
                  onSubmit={
                    conversationId && conversation?.agent.id
                      ? handleSubmit
                      : handleInitialSubmit
                  }
                  status={
                    conversationId && conversation?.agent.id
                      ? status
                      : createConversationMutation.isPending
                        ? "submitted"
                        : "ready"
                  }
                  selectedModel={
                    conversationId && conversation?.agent.id
                      ? (conversation?.selectedModel ?? "")
                      : initialModel
                  }
                  onModelChange={
                    conversationId && conversation?.agent.id
                      ? handleModelChange
                      : handleInitialModelChange
                  }
                  messageCount={
                    conversationId && conversation?.agent.id
                      ? messages.length
                      : undefined
                  }
                  agentId={
                    conversationId && conversation?.agent.id
                      ? conversation.agent.id
                      : activeAgentId
                  }
                  conversationId={conversationId}
                  currentConversationChatApiKeyId={
                    conversationId && conversation?.agent.id
                      ? conversation?.chatApiKeyId
                      : undefined
                  }
                  currentProvider={
                    conversationId && conversation?.agent.id
                      ? currentProvider
                      : initialProvider
                  }
                  textareaRef={textareaRef}
                  initialApiKeyId={
                    conversationId && conversation?.agent.id
                      ? undefined
                      : initialApiKeyId
                  }
                  onApiKeyChange={
                    conversationId && conversation?.agent.id
                      ? undefined
                      : setInitialApiKeyId
                  }
                  promptId={
                    conversationId && conversation?.agent.id
                      ? conversation?.agent?.agentType === "agent"
                        ? conversation?.agentId
                        : null
                      : initialPromptId
                  }
                  allowFileUploads={organization?.allowChatFileUploads ?? false}
                  isModelsLoading={isModelsLoading}
                />
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

      {isBrowserPanelOpen && isBrowserStreamingEnabled && hasPlaywrightMcp && (
        <BrowserPanel
          isOpen={isBrowserPanelOpen}
          onClose={() => setIsBrowserPanelOpen(false)}
          conversationId={conversationId}
        />
      )}

      {/* Right-side artifact panel */}
      <ConversationArtifactPanel
        artifact={conversation?.artifact}
        isOpen={isArtifactOpen}
        onToggle={toggleArtifactPanel}
      />

      <AgentDialog
        open={isAgentDialogOpen}
        onOpenChange={(open) => {
          setIsAgentDialogOpen(open);
          if (!open) {
            setEditingAgentId(null);
          }
        }}
        agent={editingAgent}
        agentType="agent"
        onViewVersionHistory={setVersionHistoryAgent}
      />

      <PromptVersionHistoryDialog
        open={!!versionHistoryAgent}
        onOpenChange={(open) => {
          if (!open) {
            setVersionHistoryAgent(null);
          }
        }}
        agent={versionHistoryAgent}
      />
    </div>
  );
}
