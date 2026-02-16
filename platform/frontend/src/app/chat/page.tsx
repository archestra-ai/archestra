"use client";

import type { UIMessage } from "@ai-sdk/react";

import { Bot, Edit, FileText, Globe, Plus } from "lucide-react";

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
import { CreateCatalogDialog } from "@/app/mcp-catalog/_parts/create-catalog-dialog";
import { CustomServerRequestDialog } from "@/app/mcp-catalog/_parts/custom-server-request-dialog";
import { AgentDialog } from "@/components/agent-dialog";
import type { PromptInputProps } from "@/components/ai-elements/prompt-input";
import { AgentSelector } from "@/components/chat/agent-selector";
import { ChatMessages } from "@/components/chat/chat-messages";
import { InitialAgentSelector } from "@/components/chat/initial-agent-selector";
import {
  PlaywrightInstallDialog,
  usePlaywrightSetupRequired,
} from "@/components/chat/playwright-install-dialog";
import { PromptVersionHistoryDialog } from "@/components/chat/prompt-version-history-dialog";
import { RightSidePanel } from "@/components/chat/right-side-panel";
import { StreamTimeoutWarning } from "@/components/chat/stream-timeout-warning";
import { LoadingSpinner } from "@/components/loading";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Version } from "@/components/version";
import { useChatSession } from "@/contexts/global-chat-context";
import { useInternalAgents } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth.query";
import {
  fetchConversationEnabledTools,
  useConversation,
  useCreateConversation,
  useStopChatStream,
  useUpdateConversation,
  useUpdateConversationEnabledTools,
} from "@/lib/chat.query";
import { useChatModels, useModelsByProvider } from "@/lib/chat-models.query";
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

const LocalStorageKeys = {
  artifactOpen: "archestra-chat-artifact-open",
  browserOpen: "archestra-chat-browser-open",
  selectedChatModel: "archestra-chat-selected-chat-model",
} as const;

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
  const [isArtifactOpen, setIsArtifactOpen] = useState(false);
  const loadedConversationRef = useRef<string | undefined>(undefined);
  const pendingPromptRef = useRef<string | undefined>(undefined);
  const pendingFilesRef = useRef<
    Array<{ url: string; mediaType: string; filename?: string }>
  >([]);
  const userMessageJustEdited = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const autoSendTriggeredRef = useRef(false);
  // Store pending URL for browser navigation after conversation is created
  const [pendingBrowserUrl, setPendingBrowserUrl] = useState<
    string | undefined
  >(undefined);

  // Dialog management for MCP installation
  const { isDialogOpened, openDialog, closeDialog } = useDialogs<
    "custom-request" | "create-catalog" | "edit-agent"
  >();

  // Check if user can create catalog items directly
  const { data: canCreateCatalog } = useHasPermissions({
    internalMcpCatalog: ["create"],
  });

  // State for browser panel - initialize from localStorage
  const [isBrowserPanelOpen, setIsBrowserPanelOpen] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(LocalStorageKeys.browserOpen) === "true";
    }
    return false;
  });

  // Fetch internal agents for dialog editing
  const { data: internalAgents = [], isPending: isLoadingAgents } =
    useInternalAgents();

  // Fetch profiles and models for initial chat (no conversation)
  const { modelsByProvider, isPending: isModelsLoading } =
    useModelsByProvider();

  // State for initial chat (when no conversation exists yet)
  const [initialAgentId, setInitialAgentId] = useState<string | null>(null);
  const [initialModel, setInitialModel] = useState<string>("");
  const [initialApiKeyId, setInitialApiKeyId] = useState<string | null>(null);
  // Track if URL params have been consumed (so we don't re-apply them after user clears selection)
  const urlParamsConsumedRef = useRef(false);

  // Version history dialog state
  const [versionHistoryAgent, setVersionHistoryAgent] = useState<
    (typeof internalAgents)[number] | null
  >(null);

  // Resolve which agent to use on page load (URL param > localStorage > first available).
  // Stores the resolved agent in a ref so the model init effect can read it synchronously.
  const resolvedAgentRef = useRef<(typeof internalAgents)[number] | null>(null);

  useEffect(() => {
    if (internalAgents.length === 0) return;

    // Only process URL params once (don't re-apply after user clears selection)
    if (!urlParamsConsumedRef.current) {
      const urlAgentId = searchParams.get("agentId");
      if (urlAgentId) {
        const matchingAgent = internalAgents.find((a) => a.id === urlAgentId);
        if (matchingAgent) {
          setInitialAgentId(urlAgentId);
          resolvedAgentRef.current = matchingAgent;
          urlParamsConsumedRef.current = true;
          return;
        }
      }
    }

    // Try to restore from localStorage, then default to first internal agent
    if (!initialAgentId) {
      const savedAgentId = localStorage.getItem("selected-chat-agent");
      const savedAgent = internalAgents.find((a) => a.id === savedAgentId);
      if (savedAgent) {
        setInitialAgentId(savedAgentId);
        resolvedAgentRef.current = savedAgent;
        return;
      }
      setInitialAgentId(internalAgents[0].id);
      resolvedAgentRef.current = internalAgents[0];
    }
  }, [initialAgentId, searchParams, internalAgents]);

  // Initialize model and API key once agent is resolved.
  // Priority: agent config > localStorage > first available model.
  // Separated from agent resolution but uses ref to avoid race conditions —
  // the ref is written synchronously in the same render cycle, so this effect
  // always sees the correct agent even when both effects fire together.
  useEffect(() => {
    if (!initialAgentId) return;
    if (initialModel) return; // Already initialized

    const agent = resolvedAgentRef.current;
    const agentData = agent as Record<string, unknown> | undefined;

    // 1. Agent-configured model takes priority
    if (agentData?.llmModel) {
      setInitialModel(agentData.llmModel as string);
      if (agentData.llmApiKeyId) {
        setInitialApiKeyId(agentData.llmApiKeyId as string);
      }
      return;
    }

    // 2. Fall back to localStorage / first available (needs models loaded)
    const allModels = Object.values(modelsByProvider).flat();
    if (allModels.length === 0) return;

    const savedModelId = localStorage.getItem(
      LocalStorageKeys.selectedChatModel,
    );
    if (savedModelId && allModels.some((m) => m.id === savedModelId)) {
      setInitialModel(savedModelId);
      return;
    }

    // 3. Fall back to first available model
    const providers = Object.keys(modelsByProvider);
    if (providers.length > 0) {
      const firstProvider = providers[0];
      const models =
        modelsByProvider[firstProvider as keyof typeof modelsByProvider];
      if (models && models.length > 0) {
        setInitialModel(models[0].id);
      }
    }
  }, [initialAgentId, initialModel, modelsByProvider]);

  // Save model to localStorage when changed
  const handleInitialModelChange = useCallback((modelId: string) => {
    setInitialModel(modelId);
    localStorage.setItem(LocalStorageKeys.selectedChatModel, modelId);
  }, []);

  // Handle provider change from API key selector - auto-select a model from new provider
  const handleInitialProviderChange = useCallback(
    (newProvider: SupportedChatProvider, _apiKeyId: string) => {
      const providerModels = modelsByProvider[newProvider];
      if (providerModels && providerModels.length > 0) {
        // Try to restore from localStorage for this provider
        const savedModelKey = `selected-chat-model-${newProvider}`;
        const savedModelId = localStorage.getItem(savedModelKey);
        if (savedModelId && providerModels.some((m) => m.id === savedModelId)) {
          setInitialModel(savedModelId);
          localStorage.setItem("selected-chat-model", savedModelId);
          return;
        }
        // Fall back to first model for this provider
        const firstModel = providerModels[0];
        setInitialModel(firstModel.id);
        localStorage.setItem("selected-chat-model", firstModel.id);
      }
    },
    [modelsByProvider],
  );

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
  const { data: chatModels = [] } = useChatModels();
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

  // Initialize artifact panel state when conversation loads or changes
  useEffect(() => {
    // If no conversation (new chat), close the artifact panel
    if (!conversationId) {
      setIsArtifactOpen(false);
      return;
    }

    if (isLoadingConversation) return;

    // Check for conversation-specific preference
    const storageKey = `archestra-chat-artifact-open-${conversationId}`;
    const storedState = localStorage.getItem(storageKey);
    if (storedState !== null) {
      // User has explicitly set a preference for this conversation
      setIsArtifactOpen(storedState === "true");
    } else if (conversation?.artifact) {
      // First time viewing this conversation with an artifact - auto-open
      setIsArtifactOpen(true);
      localStorage.setItem(storageKey, "true");
    } else {
      // No artifact or no stored preference - keep closed
      setIsArtifactOpen(false);
    }
  }, [conversationId, conversation?.artifact, isLoadingConversation]);

  // Derive current provider from selected model
  const currentProvider = useMemo((): SupportedChatProvider | undefined => {
    if (!conversation?.selectedModel) return undefined;
    const model = chatModels.find((m) => m.id === conversation.selectedModel);
    return model?.provider as SupportedChatProvider | undefined;
  }, [conversation?.selectedModel, chatModels]);

  // Get selected model's context length for the context indicator
  const selectedModelContextLength = useMemo((): number | null => {
    const modelId = conversation?.selectedModel ?? initialModel;
    if (!modelId) return null;
    const model = chatModels.find((m) => m.id === modelId);
    return model?.capabilities?.contextLength ?? null;
  }, [conversation?.selectedModel, initialModel, chatModels]);

  // Get selected model's input modalities for file upload filtering
  const selectedModelInputModalities = useMemo(() => {
    const modelId = conversation?.selectedModel ?? initialModel;
    if (!modelId) return null;
    const model = chatModels.find((m) => m.id === modelId);
    return model?.capabilities?.inputModalities ?? null;
  }, [conversation?.selectedModel, initialModel, chatModels]);

  // Mutation for updating conversation model
  const updateConversationMutation = useUpdateConversation();

  // Handle model change
  const handleModelChange = useCallback(
    (model: string) => {
      if (!conversation) return;

      // Find the provider for this model
      const modelInfo = chatModels.find((m) => m.id === model);
      const provider = modelInfo?.provider as SupportedChatProvider | undefined;

      updateConversationMutation.mutate({
        id: conversation.id,
        selectedModel: model,
        selectedProvider: provider,
      });
    },
    [conversation, chatModels, updateConversationMutation],
  );

  // Handle provider change from API key selector - auto-select a model from new provider
  const handleProviderChange = useCallback(
    (newProvider: SupportedChatProvider, _apiKeyId: string) => {
      if (!conversation) return;

      const providerModels = modelsByProvider[newProvider];
      if (providerModels && providerModels.length > 0) {
        // Select first model from the new provider
        const firstModel = providerModels[0];
        updateConversationMutation.mutate({
          id: conversation.id,
          selectedModel: firstModel.id,
          selectedProvider: newProvider,
        });
      }
    },
    [conversation, modelsByProvider, updateConversationMutation],
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

  const playwrightSetupAgentId = conversationId
    ? conversation?.agentId
    : (initialAgentId ?? undefined);
  const {
    isLoading: isPlaywrightCheckLoading,
    isRequired: isPlaywrightSetupRequired,
  } = usePlaywrightSetupRequired(playwrightSetupAgentId, conversationId);
  // Treat both loading and required as "visible" for disabling submit, hiding arrow, etc.
  const isPlaywrightSetupVisible =
    isPlaywrightSetupRequired || isPlaywrightCheckLoading;

  // Check if browser streaming feature is enabled
  const isBrowserStreamingEnabled = useFeatureFlag("browserStreamingEnabled");

  // Create conversation mutation (requires agentId)
  const createConversationMutation = useCreateConversation();

  // Update enabled tools mutation (for applying pending actions)
  const updateEnabledToolsMutation = useUpdateConversationEnabledTools();

  // Stop chat stream mutation (signals backend to abort subagents)
  const stopChatStreamMutation = useStopChatStream();

  // Persist artifact panel state
  const toggleArtifactPanel = useCallback(() => {
    const newValue = !isArtifactOpen;
    setIsArtifactOpen(newValue);
    // Only persist state for active conversations
    if (conversationId) {
      const storageKey = `archestra-chat-artifact-open-${conversationId}`;
      localStorage.setItem(storageKey, String(newValue));
    }
  }, [isArtifactOpen, conversationId]);

  // Auto-open artifact panel when artifact is updated during conversation
  const previousArtifactRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // Only auto-open if:
    // 1. We have a conversation with an artifact
    // 2. The artifact has changed (not just initial load)
    // 3. The panel is currently closed
    // 4. This is an update to an existing conversation (not initial load)
    if (
      conversationId &&
      conversation?.artifact &&
      previousArtifactRef.current !== undefined && // Not the initial render
      previousArtifactRef.current !== conversation.artifact &&
      conversation.artifact !== previousArtifactRef.current && // Artifact actually changed
      !isArtifactOpen
    ) {
      setIsArtifactOpen(true);
      // Save the preference for this conversation
      const storageKey = `archestra-chat-artifact-open-${conversationId}`;
      localStorage.setItem(storageKey, "true");
    }

    // Update the ref for next comparison
    previousArtifactRef.current = conversation?.artifact;
  }, [conversation?.artifact, isArtifactOpen, conversationId]);

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
  const tokenUsage = chatSession?.tokenUsage;

  // Use actual token usage when available from the stream (no fallback to estimation)
  const tokensUsed = tokenUsage?.totalTokens;

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

  // Auto-focus textarea on initial page load
  useEffect(() => {
    // Use requestAnimationFrame to ensure DOM is ready
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, []);

  const handleSubmit: PromptInputProps["onSubmit"] = (message, e) => {
    e.preventDefault();
    if (isPlaywrightSetupVisible) return;
    if (status === "submitted" || status === "streaming") {
      if (conversationId) {
        // Set the cache flag first, THEN close the connection so the
        // connection-close handler on the backend finds the flag.
        stopChatStreamMutation.mutateAsync(conversationId).finally(() => {
          stop?.();
        });
      } else {
        stop?.();
      }
      return;
    }

    const hasText = message.text?.trim();
    const hasFiles = message.files && message.files.length > 0;

    if (!sendMessage || (!hasText && !hasFiles)) {
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

  // Persist browser panel state - just opens panel, installation happens inside if needed
  const toggleBrowserPanel = useCallback(() => {
    const newValue = !isBrowserPanelOpen;
    setIsBrowserPanelOpen(newValue);
    localStorage.setItem(LocalStorageKeys.browserOpen, String(newValue));
  }, [isBrowserPanelOpen]);

  // Close browser panel handler (also persists to localStorage)
  const closeBrowserPanel = useCallback(() => {
    setIsBrowserPanelOpen(false);
    localStorage.setItem(LocalStorageKeys.browserOpen, "false");
  }, []);

  // Handle creating conversation from browser URL input (when no conversation exists)
  const handleCreateConversationWithUrl = useCallback(
    (url: string) => {
      if (!initialAgentId || createConversationMutation.isPending) {
        return;
      }

      // Store the URL to navigate to after conversation is created
      setPendingBrowserUrl(url);

      // Find the provider for the initial model
      const modelInfo = chatModels.find((m) => m.id === initialModel);
      const selectedProvider = modelInfo?.provider as
        | SupportedChatProvider
        | undefined;

      // Create conversation with the selected agent
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
              selectConversation(newConversation.id);
              // URL navigation will happen via useBrowserStream after conversation connects
            }
          },
        },
      );
    },
    [
      initialAgentId,
      initialModel,
      initialApiKeyId,
      chatModels,
      createConversationMutation,
      selectConversation,
    ],
  );

  // Callback to clear pending browser URL after navigation completes
  const handleInitialNavigateComplete = useCallback(() => {
    setPendingBrowserUrl(undefined);
  }, []);

  // Handle initial agent change (when no conversation exists)
  const handleInitialAgentChange = useCallback(
    (agentId: string) => {
      setInitialAgentId(agentId);
      localStorage.setItem("selected-chat-agent", agentId);

      // Apply agent's LLM config if present
      const selectedAgent = internalAgents.find((a) => a.id === agentId);
      if (selectedAgent) {
        resolvedAgentRef.current = selectedAgent;
        const agentData = selectedAgent as Record<string, unknown>;
        if (agentData.llmModel) {
          setInitialModel(agentData.llmModel as string);
        }
        if (agentData.llmApiKeyId) {
          setInitialApiKeyId(agentData.llmApiKeyId as string);
        }
      }
    },
    [internalAgents],
  );

  // Handle initial submit (when no conversation exists)
  const handleInitialSubmit: PromptInputProps["onSubmit"] = useCallback(
    (message, e) => {
      e.preventDefault();
      if (isPlaywrightSetupVisible) return;
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
      const pendingActions = getPendingActions(initialAgentId);

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
                  const data = await fetchConversationEnabledTools(
                    newConversation.id,
                  );
                  if (data) {
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

              selectConversation(newConversation.id);
            }
          },
        },
      );
    },
    [
      isPlaywrightSetupVisible,
      initialAgentId,
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
  const activeAgentId = conversation?.agent?.id ?? initialAgentId;

  // Show loading spinner while essential data is loading
  if (isLoadingApiKeyCheck || isLoadingAgents || isPlaywrightCheckLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <LoadingSpinner />
      </div>
    );
  }

  // If API key is not configured, show setup message
  if (!hasAnyApiKey) {
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

  // If no agents exist, show empty state
  if (internalAgents.length === 0) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Bot />
          </EmptyMedia>
          <EmptyTitle>No agents yet</EmptyTitle>
          <EmptyDescription>
            Create an agent to start chatting.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild>
            <Link href="/agents?create=true">
              <Plus className="mr-2 h-4 w-4" />
              Create Agent
            </Link>
          </Button>
        </EmptyContent>
      </Empty>
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
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex flex-col h-full">
          <StreamTimeoutWarning status={status} messages={messages} />

          <div className="sticky top-0 z-10 bg-background border-b p-2">
            <div className="flex items-start justify-between gap-2">
              {/* Left side - agent selector stays fixed, tools wrap internally */}
              <div className="flex items-start gap-2 min-w-0 flex-1">
                {/* Agent/Profile selector - fixed width */}
                <div className="flex-shrink-0 flex items-center gap-2">
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
                      currentAgentId={initialAgentId}
                      onAgentChange={handleInitialAgentChange}
                    />
                  )}
                  {/* Edit agent button */}
                  {(conversationId
                    ? conversation?.agentId
                    : initialAgentId) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openDialog("edit-agent")}
                      title="Edit agent, tools, sub-agents"
                      className="h-8 px-2"
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
              {/* Right side - show/hide controls */}
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button
                  variant={isArtifactOpen ? "secondary" : "ghost"}
                  size="sm"
                  onClick={toggleArtifactPanel}
                  className="text-xs"
                >
                  <FileText className="h-3 w-3 mr-1" />
                  Artifact
                </Button>
                {isBrowserStreamingEnabled && (
                  <>
                    <div className="w-px h-4 bg-border" />
                    <Button
                      variant={
                        isBrowserPanelOpen && !isPlaywrightSetupVisible
                          ? "secondary"
                          : "ghost"
                      }
                      size="sm"
                      onClick={toggleBrowserPanel}
                      className="text-xs"
                      disabled={isPlaywrightSetupVisible}
                    >
                      <Globe className="h-3 w-3 mr-1" />
                      Browser
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto relative">
            {isPlaywrightSetupRequired && (
              <PlaywrightInstallDialog
                agentId={playwrightSetupAgentId}
                conversationId={conversationId}
              />
            )}
            <ChatMessages
              conversationId={conversationId}
              agentId={currentProfileId || initialAgentId || undefined}
              agentName={
                _conversationInternalAgent?.name ||
                internalAgents.find((a) => a.id === initialAgentId)?.name
              }
              suggestedPrompt={
                conversationId
                  ? undefined
                  : internalAgents.find((a) => a.id === initialAgentId)
                      ?.userPrompt
              }
              onSuggestedPromptClick={
                conversationId
                  ? undefined
                  : () => {
                      const selectedAgent = internalAgents.find(
                        (a) => a.id === initialAgentId,
                      );
                      const userPrompt = selectedAgent?.userPrompt;
                      if (!userPrompt) return;
                      const syntheticEvent = {
                        preventDefault: () => {},
                      } as React.FormEvent<HTMLFormElement>;
                      handleInitialSubmit(
                        { text: userPrompt, files: [] },
                        syntheticEvent,
                      );
                    }
              }
              hideArrow={isPlaywrightSetupVisible}
              messages={messages}
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
                  onProviderChange={
                    conversationId && conversation?.agent.id
                      ? handleProviderChange
                      : handleInitialProviderChange
                  }
                  allowFileUploads={organization?.allowChatFileUploads ?? false}
                  isModelsLoading={isModelsLoading}
                  onEditAgent={() => openDialog("edit-agent")}
                  tokensUsed={tokensUsed}
                  maxContextLength={selectedModelContextLength}
                  inputModalities={selectedModelInputModalities}
                  agentLlmApiKeyId={
                    conversationId && conversation?.agent.id
                      ? ((conversation.agent as Record<string, unknown>)
                          .llmApiKeyId as string | null)
                      : ((
                          internalAgents.find((a) => a.id === initialAgentId) as
                            | Record<string, unknown>
                            | undefined
                        )?.llmApiKeyId as string | null)
                  }
                  submitDisabled={isPlaywrightSetupVisible}
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
      <AgentDialog
        open={isDialogOpened("edit-agent")}
        onOpenChange={(open) => {
          if (!open) closeDialog("edit-agent");
        }}
        agent={
          conversationId && conversation
            ? _conversationInternalAgent
            : initialAgentId
              ? internalAgents.find((a) => a.id === initialAgentId)
              : undefined
        }
        agentType="agent"
      />

      {/* Right-side panel with artifact and browser preview */}
      <RightSidePanel
        artifact={conversation?.artifact}
        isArtifactOpen={isArtifactOpen}
        onArtifactToggle={toggleArtifactPanel}
        isBrowserOpen={
          isBrowserPanelOpen &&
          isBrowserStreamingEnabled &&
          !isPlaywrightSetupVisible
        }
        onBrowserClose={closeBrowserPanel}
        conversationId={conversationId}
        agentId={browserToolsAgentId}
        onCreateConversationWithUrl={handleCreateConversationWithUrl}
        isCreatingConversation={createConversationMutation.isPending}
        initialNavigateUrl={pendingBrowserUrl}
        onInitialNavigateComplete={handleInitialNavigateComplete}
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
