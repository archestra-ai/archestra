"use client";

import type { UIMessage } from "@ai-sdk/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  CornerDownLeftIcon,
  MicIcon,
  PaperclipIcon,
  Plus,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CreateCatalogDialog } from "@/app/mcp/registry/_parts/create-catalog-dialog";
import { CustomServerRequestDialog } from "@/app/mcp/registry/_parts/custom-server-request-dialog";
import { AgentDialog } from "@/components/agent-dialog";
import type { PromptInputProps } from "@/components/ai-elements/prompt-input";
import { Suggestion } from "@/components/ai-elements/suggestion";
import { AppLogo } from "@/components/app-logo";
import { ButtonWithTooltip } from "@/components/button-with-tooltip";
import { ChatLinkButton } from "@/components/chat/chat-help-link";
import { ChatMessages } from "@/components/chat/chat-messages";
import { InitialAgentSelector } from "@/components/chat/initial-agent-selector";
import { OnboardingWizardButton } from "@/components/chat/onboarding-wizard-button";
import {
  PlaywrightInstallDialog,
  usePlaywrightSetupRequired,
} from "@/components/chat/playwright-install-dialog";
import { RightSidePanel } from "@/components/chat/right-side-panel";
import { ShareConversationDialog } from "@/components/chat/share-conversation-dialog";
import { StreamTimeoutWarning } from "@/components/chat/stream-timeout-warning";
import { LoadingSpinner } from "@/components/loading";
import MessageThread from "@/components/message-thread";
import { StandardDialog } from "@/components/standard-dialog";
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
import { useDefaultAgentId, useInternalAgents } from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useRecentlyGeneratedTitles } from "@/lib/chat/chat.hook";
import {
  useCreateConversation,
  useHasPlaywrightMcpTools,
  useStopChatStream,
  useUpdateConversation,
} from "@/lib/chat/chat.query";
import {
  useConversationShare,
  useForkSharedConversation,
} from "@/lib/chat/chat-share.query";
import {
  clearModelOverride,
  getSavedModelOverride,
  type ModelSource,
} from "@/lib/chat/use-chat-preferences";
import { useConfig } from "@/lib/config/config.query";
import { useDialogs } from "@/lib/hooks/use-dialog";
import { useIsMobile } from "@/lib/hooks/use-mobile";
import { useLlmModels, useLlmModelsByProvider } from "@/lib/llm-models.query";
import {
  type SupportedProvider,
  useLlmProviderApiKeys,
} from "@/lib/llm-provider-api-keys.query";
import { useOrganization } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import { cn } from "@/lib/utils";
import { useChatLifecycle } from "../_hooks/use-chat-lifecycle";
import { useChatPanelsState } from "../_hooks/use-chat-panels-state";
import { useConversationChatState } from "../_hooks/use-conversation-chat-state";
import { useInitialChatState } from "../_hooks/use-initial-chat-state";
import {
  buildCreateConversationInput,
  resolveChatModelState,
  resolvePreferredModelForProvider,
  shouldResetInitialChatState,
} from "../_utils/chat-initial-state";
import { resolveSharedConversationForkState } from "../_utils/shared-conversation-fork";
import { ChatHeader } from "./chat-header";
import { ChatMobilePanels } from "./chat-mobile-panels";
import { NoApiKeySetup } from "./no-api-key-setup";
import ArchestraPromptInput from "./prompt-input";

export function ChatPageContent({
  routeConversationId,
}: {
  routeConversationId?: string;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [conversationId, setConversationId] = useState<string | undefined>(
    routeConversationId,
  );

  // Hide version display from layout - chat page has its own version display
  useEffect(() => {
    document.body.classList.add("hide-version");
    return () => document.body.classList.remove("hide-version");
  }, []);
  const userMessageJustEdited = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [isForkDialogOpen, setIsForkDialogOpen] = useState(false);
  const [forkAgentId, setForkAgentId] = useState<string | null>(null);
  const forkSharedConversationMutation = useForkSharedConversation();
  const { data: session } = useSession();

  // Dialog management for MCP installation
  const { isDialogOpened, openDialog, closeDialog } = useDialogs<
    "custom-request" | "create-catalog" | "edit-agent"
  >();

  // Check if user can create catalog items directly
  const { data: canCreateCatalog } = useHasPermissions({
    mcpRegistry: ["create"],
  });

  const { data: isAgentAdmin } = useHasPermissions({
    agent: ["admin"],
  });
  const { data: canCreateAgent } = useHasPermissions({
    agent: ["create"],
  });
  const { data: canReadAgent } = useHasPermissions({
    agent: ["read"],
  });
  const { data: canReadLlmProvider } = useHasPermissions({
    llmProviderApiKey: ["read"],
  });
  const { data: canReadLlmModels } = useHasPermissions({
    llmModel: ["read"],
  });
  const { data: canSeeProviderSettings } = useHasPermissions({
    chatProviderSettings: ["enable"],
  });
  const { data: canReadTeams } = useHasPermissions({
    team: ["read"],
  });
  const { data: canUpdateAgent } = useHasPermissions({
    agent: ["team-admin"],
  });
  const { data: teams } = useTeams({ enabled: !!canReadTeams });

  // Non-admin users with no teams cannot create agents
  const cannotCreateDueToNoTeams =
    !isAgentAdmin && (!teams || teams.length === 0);

  const _isMobile = useIsMobile();

  const hasChatAccess = canReadAgent !== false;
  const canUseProviderSettings =
    canSeeProviderSettings === true &&
    canReadLlmProvider === true &&
    canReadLlmModels === true;

  // Fetch internal agents for dialog editing
  const { data: internalAgents = [], isPending: isLoadingAgents } =
    useInternalAgents({ enabled: hasChatAccess });
  const { data: defaultAgentId } = useDefaultAgentId();

  // Fetch profiles and models for initial chat (no conversation)
  const { modelsByProvider, isPending: isModelsLoading } =
    useLlmModelsByProvider({ enabled: canUseProviderSettings });
  const { data: chatApiKeys = [], isLoading: isLoadingApiKeys } =
    useLlmProviderApiKeys({ enabled: hasChatAccess && canUseProviderSettings });
  const { data: organization, isPending: isOrgLoading } = useOrganization();

  const previousRouteConversationIdRef = useRef<string | undefined>(
    routeConversationId,
  );
  const {
    handleInitialAgentChange,
    handleInitialModelChange,
    handleInitialModelSelectorOpenChange,
    handleInitialProviderChange,
    handleResetModelOverride,
    initialAgentId,
    initialApiKeyId,
    initialModel,
    initialModelSource,
    initialProvider,
    resetInitialChatState,
    setInitialApiKeyId,
  } = useInitialChatState({
    internalAgents,
    defaultAgentId,
    searchParams,
    modelsByProvider,
    chatApiKeys,
    organization: organization ?? null,
    isOrgLoading,
  });

  const { isLoading: isLoadingFeatures } = useConfig();
  const { data: chatModels = [] } = useLlmModels();
  // Check if user has any API keys (including system keys for keyless providers
  // like Vertex AI Gemini, vLLM, or Ollama which don't require secrets)
  const hasAnyApiKey = chatApiKeys.length > 0;
  const isLoadingApiKeyCheck = isLoadingApiKeys || isLoadingFeatures;

  useEffect(() => {
    setConversationId(routeConversationId);

    const previousRouteConversationId = previousRouteConversationIdRef.current;
    previousRouteConversationIdRef.current = routeConversationId;

    if (
      shouldResetInitialChatState({
        previousRouteConversationId,
        routeConversationId,
      })
    ) {
      resetInitialChatState();
    }

    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [routeConversationId, resetInitialChatState]);

  // Get user_prompt from URL for auto-sending
  const initialUserPrompt = useMemo(() => {
    return searchParams.get("user_prompt") || undefined;
  }, [searchParams]);

  // Source of truth split:
  // - before a conversation exists, agent/model/key live in useInitialChatState
  // - after a conversation exists, useConversationChatState owns the API record
  //   plus the live streaming session.
  // Update URL when conversation changes
  const selectConversation = useCallback(
    (id: string | undefined) => {
      setConversationId(id);
      if (id) {
        router.push(`/chat/${id}`);
      } else {
        router.push("/chat");
      }
    },
    [router],
  );

  const {
    activeAgentId,
    addToolApprovalResponse,
    addToolResult,
    canManageShare,
    conversation,
    conversationAgentId,
    error,
    isLoadingConversation,
    isReadOnlySharedConversation,
    isShared,
    messages,
    optimisticToolCalls,
    pendingCustomServerToolCall,
    promptAgentId,
    sendMessage,
    setMessages,
    setPendingCustomServerToolCall,
    sharedConversationMessages,
    status,
    stop,
    swappedAgentName,
    tokenUsage,
  } = useConversationChatState({
    conversationId,
    routeConversationId,
    sessionUserId: session?.user.id,
    initialAgentId,
    agents: internalAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
    })),
    queryClient,
  });
  const {
    closeBrowserPanel,
    handleInitialNavigateComplete,
    isArtifactOpen,
    isBrowserPanelOpen,
    pendingBrowserUrl,
    setPendingBrowserUrl,
    toggleArtifactPanel,
    toggleBrowserPanel,
  } = useChatPanelsState({
    conversationId,
    artifact: conversation?.artifact,
    isLoadingConversation,
  });
  useConversationShare(canManageShare ? conversationId : undefined);
  const sharedConversationAgentId =
    conversation?.agentId ?? conversation?.agent?.id ?? null;
  const {
    accessibleSharedAgentId,
    shouldPromptForForkAgentSelection,
    effectiveAgentId: effectiveForkAgentId,
  } = useMemo(
    () =>
      resolveSharedConversationForkState({
        availableAgentIds: internalAgents.map((agent) => agent.id),
        selectedAgentId: forkAgentId,
        sharedConversationAgentId,
      }),
    [forkAgentId, internalAgents, sharedConversationAgentId],
  );

  useEffect(() => {
    if (isForkDialogOpen) {
      return;
    }

    setForkAgentId(accessibleSharedAgentId);
  }, [accessibleSharedAgentId, isForkDialogOpen]);

  // Track title generation for typing animation in the header
  const conversationForTitleTracking = useMemo(
    () =>
      conversation ? [{ id: conversation.id, title: conversation.title }] : [],
    [conversation],
  );
  const { recentlyGeneratedTitles: headerAnimatingTitles } =
    useRecentlyGeneratedTitles(conversationForTitleTracking);

  // Derive current provider from selected model
  const currentProvider = useMemo((): SupportedProvider | undefined => {
    if (!conversation?.selectedModel) return undefined;
    const model = chatModels.find((m) => m.id === conversation.selectedModel);
    return model?.provider;
  }, [conversation?.selectedModel, chatModels]);

  // Derive model source for existing conversations by comparing with agent/org defaults.
  // Check localStorage override first — if the user explicitly saved this model as their
  // override, it's a user override even if it matches the agent or org default.
  const conversationModelSource = useMemo((): ModelSource | null => {
    if (!conversation?.selectedModel) return null;

    const userOverride = getSavedModelOverride();
    if (userOverride && conversation.selectedModel === userOverride) {
      return "user";
    }

    const agentId = conversation?.agentId;
    if (agentId) {
      const agent = internalAgents.find((a) => a.id === agentId) as
        | (Record<string, unknown> & { llmModel?: string })
        | undefined;
      if (agent?.llmModel && conversation.selectedModel === agent.llmModel) {
        return "agent";
      }
    }
    if (
      organization?.defaultLlmModel &&
      conversation.selectedModel === organization.defaultLlmModel
    ) {
      return "organization";
    }
    return null;
  }, [
    conversation?.selectedModel,
    conversation?.agentId,
    internalAgents,
    organization?.defaultLlmModel,
  ]);

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
  // Use a ref so callbacks don't recreate when mutation state changes (isPending etc.),
  // which would cause infinite re-render loops via Radix composeRefs during commit phase.
  const updateConversationMutation = useUpdateConversation();
  const updateConversationMutateRef = useRef(updateConversationMutation.mutate);
  updateConversationMutateRef.current = updateConversationMutation.mutate;

  // Handle model change — use refs for chatModels and conversation to keep
  // callback reference stable. A new callback reference would re-trigger
  // ModelSelector's auto-select effect on every chatModels refetch.
  const chatModelsRef = useRef(chatModels);
  chatModelsRef.current = chatModels;
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const handleModelChange = useCallback((model: string) => {
    if (!conversationRef.current) return;

    // Find the provider for this model
    const modelInfo = chatModelsRef.current.find((m) => m.id === model);
    const provider = modelInfo?.provider;

    updateConversationMutateRef.current({
      id: conversationRef.current.id,
      selectedModel: model,
      selectedProvider: provider,
    });
  }, []);

  // Handle API key change - preselect best model for the new key's provider.
  // Combines chatApiKeyId + model selection in a single mutation to avoid
  // race conditions between competing updates.
  const handleProviderChange = useCallback(
    (newProvider: SupportedProvider, apiKeyId: string) => {
      if (!conversation) return;

      const preferredModel = resolvePreferredModelForProvider({
        provider: newProvider,
        modelsByProvider,
      });
      if (preferredModel) {
        updateConversationMutateRef.current({
          id: conversation.id,
          chatApiKeyId: apiKeyId,
          selectedModel: preferredModel.modelId,
          selectedProvider: preferredModel.provider,
        });
      } else {
        // No models for this provider yet, still update the key
        updateConversationMutateRef.current({
          id: conversation.id,
          chatApiKeyId: apiKeyId,
        });
      }
    },
    [conversation, modelsByProvider],
  );

  // Handle agent change in existing conversation
  const handleConversationAgentChange = useCallback(
    (agentId: string) => {
      if (!conversation) return;
      updateConversationMutateRef.current({
        id: conversation.id,
        agentId,
      });
    },
    [conversation],
  );

  // Reset model override for an existing conversation: clear localStorage,
  // resolve default from the conversation's agent, and update the conversation.
  const handleConversationResetModelOverride = useCallback(() => {
    clearModelOverride();
    if (!conversation) return;

    const agent = conversation.agentId
      ? (internalAgents.find((a) => a.id === conversation.agentId) as
          | (Record<string, unknown> & {
              id: string;
              llmModel?: string;
              llmApiKeyId?: string;
            })
          | undefined)
      : null;

    const resolved = resolveChatModelState({
      agent: agent ?? null,
      modelsByProvider,
      chatApiKeys,
      organization: organization
        ? {
            defaultLlmModel: organization.defaultLlmModel,
            defaultLlmApiKeyId: organization.defaultLlmApiKeyId,
          }
        : null,
      chatModels,
    });

    if (resolved) {
      updateConversationMutateRef.current({
        id: conversation.id,
        selectedModel: resolved.modelId,
        selectedProvider: resolved.provider,
      });
    }
  }, [
    conversation,
    internalAgents,
    modelsByProvider,
    chatApiKeys,
    organization,
    chatModels,
  ]);

  // Create conversation mutation (requires agentId)
  const createConversationMutation = useCreateConversation();

  // Stop chat stream mutation (signals backend to abort subagents)
  const stopChatStreamMutation = useStopChatStream();

  const newChatAgentId =
    activeAgentId ?? initialAgentId ?? internalAgents[0]?.id ?? null;

  // Find the specific internal agent for this conversation (if any)
  const _conversationInternalAgent = conversationAgentId
    ? internalAgents.find((a) => a.id === conversationAgentId)
    : undefined;

  // Get current agent info
  const currentProfileId = conversationAgentId;
  const conversationToolsStateId = isReadOnlySharedConversation
    ? undefined
    : conversationId;
  const browserToolsAgentId = isReadOnlySharedConversation
    ? undefined
    : conversationId
      ? (conversationAgentId ?? promptAgentId ?? undefined)
      : (initialAgentId ?? undefined);

  const playwrightSetupAgentId = isReadOnlySharedConversation
    ? undefined
    : conversationId
      ? (conversationAgentId ?? undefined)
      : (initialAgentId ?? undefined);

  const { hasPlaywrightMcpTools, isLoading: isLoadingBrowserTools } =
    useHasPlaywrightMcpTools(browserToolsAgentId, conversationToolsStateId);
  // Show while loading so it doesn't flash hidden for members whose agent already has playwright
  // tools. Once loading is done, hides only if the user lacks permission AND agent has no tools.
  const showBrowserButton =
    !isReadOnlySharedConversation &&
    (canUpdateAgent ||
      hasPlaywrightMcpTools ||
      (!!conversationId && isLoadingConversation) ||
      (!!browserToolsAgentId && isLoadingBrowserTools));

  const {
    isLoading: isPlaywrightCheckLoading,
    isRequired: isPlaywrightSetupRequired,
  } = usePlaywrightSetupRequired(
    playwrightSetupAgentId,
    conversationToolsStateId,
    {
      enabled:
        !isReadOnlySharedConversation &&
        hasChatAccess &&
        canUpdateAgent !== false,
    },
  );
  // Treat both loading and required as "visible" for disabling submit, hiding arrow, etc.
  // Only applies to users who can actually perform the installation.
  const isPlaywrightSetupVisible =
    !!canUpdateAgent && (isPlaywrightSetupRequired || isPlaywrightCheckLoading);

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

  useEffect(() => {
    if (status === "ready" && userMessageJustEdited.current) {
      userMessageJustEdited.current = false;
    }
  }, [status]);

  // Auto-focus textarea when status becomes ready (message sent or stream finished)
  // or when conversation loads (e.g., new chat created, hard refresh)
  useLayoutEffect(() => {
    if (status === "ready" && conversation?.id && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [status, conversation?.id]);

  // Auto-focus textarea on initial page load
  useEffect(() => {
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

    // Auto-deny any pending tool approvals before sending new message
    // to avoid "No tool output found for function call" error
    if (setMessages) {
      const hasPendingApprovals = messages.some((msg) =>
        msg.parts.some(
          (part) => "state" in part && part.state === "approval-requested",
        ),
      );

      if (hasPendingApprovals) {
        setMessages(
          messages.map((msg) => ({
            ...msg,
            parts: msg.parts.map((part) =>
              "state" in part && part.state === "approval-requested"
                ? {
                    ...part,
                    state: "output-denied" as const,
                    output:
                      "Tool approval was skipped because the user sent a new message",
                  }
                : part,
            ),
          })) as UIMessage[],
        );
      }
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
      metadata: { createdAt: new Date().toISOString() },
    });
  };

  // Handle creating conversation from browser URL input (when no conversation exists)
  const createInitialConversation = useCallback(
    (onSuccess?: (newConversation: { id: string }) => void | Promise<void>) => {
      if (createConversationMutation.isPending) {
        return false;
      }

      const input = buildCreateConversationInput({
        agentId: initialAgentId,
        modelId: initialModel,
        chatApiKeyId: initialApiKeyId,
        chatModels,
      });
      if (!input) {
        return false;
      }

      createConversationMutation.mutate(input, {
        onSuccess: (newConversation) => {
          if (newConversation) {
            void onSuccess?.(newConversation);
          }
        },
      });
      return true;
    },
    [
      initialAgentId,
      initialModel,
      initialApiKeyId,
      chatModels,
      createConversationMutation,
    ],
  );

  const handleCreateConversationWithUrl = useCallback(
    (url: string) => {
      // Store the URL to navigate to after conversation is created
      setPendingBrowserUrl(url);

      const started = createInitialConversation((newConversation) => {
        selectConversation(newConversation.id);
        // URL navigation will happen via useBrowserStream after conversation connects
      });

      if (!started) {
        setPendingBrowserUrl(undefined);
      }
    },
    [createInitialConversation, selectConversation, setPendingBrowserUrl],
  );

  const handleForkSharedConversation = useCallback(async () => {
    if (!conversation?.share?.id || !effectiveForkAgentId) {
      return;
    }

    const result = await forkSharedConversationMutation.mutateAsync({
      shareId: conversation.share.id,
      agentId: effectiveForkAgentId,
    });

    if (result) {
      setIsForkDialogOpen(false);
      router.push(`/chat/${result.id}`);
    }
  }, [
    conversation?.share?.id,
    effectiveForkAgentId,
    forkSharedConversationMutation,
    router,
  ]);

  const { submitInitialMessage } = useChatLifecycle({
    conversationId,
    conversation,
    messagesLength: messages.length,
    status,
    sendMessage,
    setMessages,
    initialUserPrompt,
    initialAgentId,
    isCreateConversationPending: createConversationMutation.isPending,
    isPlaywrightSetupVisible,
    createInitialConversation,
    selectConversation,
    queryClient,
  });

  // Form submit handler wraps submitInitialMessage with event.preventDefault
  const handleInitialSubmit: PromptInputProps["onSubmit"] = useCallback(
    (message, e) => {
      e.preventDefault();
      submitInitialMessage(message);
    },
    [submitInitialMessage],
  );

  // Check if the conversation's agent was deleted
  const isAgentDeleted = conversationId && conversation && !conversation.agent;

  // If user lacks permission to read agents, show access denied
  // Must check before loading state since disabled queries stay in pending state
  if (!conversationId && canReadAgent === false) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AlertTriangle />
          </EmptyMedia>
          <EmptyTitle>Access restricted</EmptyTitle>
          <EmptyDescription>
            You don&apos;t have the required permissions to use the chat. Ask
            your administrator to grant you the following:
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <code className="rounded bg-muted px-2 py-1 text-sm font-mono">
            agent:read
          </code>
        </EmptyContent>
      </Empty>
    );
  }

  // Show loading spinner while essential data is loading
  if (isLoadingApiKeyCheck || isLoadingAgents || isPlaywrightCheckLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <LoadingSpinner />
      </div>
    );
  }

  // If API key is not configured, show setup prompt with inline creation dialog
  if (!hasAnyApiKey) {
    return <NoApiKeySetup />;
  }

  // If no agents exist and we're not viewing a conversation with a deleted agent, show empty state
  if (internalAgents.length === 0 && !isAgentDeleted) {
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
          {cannotCreateDueToNoTeams ? (
            <ButtonWithTooltip
              disabled
              disabledText={
                canCreateAgent
                  ? "You need to be a member of at least one team to create agents"
                  : "You don't have permission to create agents"
              }
            >
              <Plus className="mr-2 h-4 w-4" />
              Create Agent
            </ButtonWithTooltip>
          ) : (
            <Button asChild>
              <Link href="/agents?create=true">
                <Plus className="mr-2 h-4 w-4" />
                Create Agent
              </Link>
            </Button>
          )}
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

          <ChatHeader
            canManageShare={canManageShare}
            conversation={conversation}
            conversationId={conversationId}
            headerAnimatingTitles={headerAnimatingTitles}
            isArtifactOpen={isArtifactOpen}
            isBrowserPanelOpen={isBrowserPanelOpen}
            isPlaywrightSetupVisible={isPlaywrightSetupVisible}
            isShared={isShared}
            onArtifactToggle={toggleArtifactPanel}
            onBrowserToggle={toggleBrowserPanel}
            onShareOpen={() => setIsShareDialogOpen(true)}
            showBrowserButton={showBrowserButton}
          />

          <ChatMobilePanels
            agentId={browserToolsAgentId}
            artifact={conversation?.artifact}
            conversationId={conversationId}
            initialNavigateUrl={pendingBrowserUrl}
            isArtifactOpen={isArtifactOpen}
            isBrowserOpen={isBrowserPanelOpen && !isPlaywrightSetupVisible}
            isCreatingConversation={createConversationMutation.isPending}
            onArtifactToggle={toggleArtifactPanel}
            onBrowserClose={closeBrowserPanel}
            onCreateConversationWithUrl={handleCreateConversationWithUrl}
            onInitialNavigateComplete={handleInitialNavigateComplete}
          />

          {conversationId ? (
            <>
              {/* Chat content - hidden on mobile when panels are open */}
              <div
                className={cn(
                  "flex-1 min-h-0 relative",
                  (isArtifactOpen ||
                    (isBrowserPanelOpen && !isPlaywrightSetupVisible)) &&
                    "hidden md:block",
                )}
              >
                {isReadOnlySharedConversation ? (
                  <MessageThread
                    messages={sharedConversationMessages}
                    containerClassName="h-full"
                    hideDivider
                    profileId={conversation?.agent?.id}
                  />
                ) : (
                  <ChatMessages
                    conversationId={conversationId}
                    agentId={currentProfileId || initialAgentId || undefined}
                    messages={messages}
                    status={status}
                    optimisticToolCalls={optimisticToolCalls}
                    isLoadingConversation={isLoadingConversation}
                    onMessagesUpdate={setMessages}
                    agentName={
                      (currentProfileId
                        ? internalAgents.find((a) => a.id === currentProfileId)
                        : internalAgents.find((a) => a.id === initialAgentId)
                      )?.name
                    }
                    selectedModel={conversation?.selectedModel ?? initialModel}
                    modelSource={conversationModelSource ?? initialModelSource}
                    chatErrors={conversation?.chatErrors ?? []}
                    onUserMessageEdit={(
                      editedMessage,
                      updatedMessages,
                      editedPartIndex,
                    ) => {
                      if (setMessages && sendMessage) {
                        userMessageJustEdited.current = true;
                        const messagesWithoutEditedMessage =
                          updatedMessages.slice(0, -1);
                        setMessages(messagesWithoutEditedMessage);
                        const editedPart =
                          editedMessage.parts?.[editedPartIndex];
                        const editedText =
                          editedPart?.type === "text" ? editedPart.text : "";
                        if (editedText?.trim()) {
                          sendMessage({
                            role: "user",
                            parts: [{ type: "text", text: editedText }],
                            metadata: { createdAt: new Date().toISOString() },
                          });
                        }
                      }
                    }}
                    error={error}
                    onToolApprovalResponse={
                      addToolApprovalResponse
                        ? ({ id, approved, reason }) => {
                            addToolApprovalResponse({ id, approved, reason });
                          }
                        : undefined
                    }
                  />
                )}
              </div>

              {isReadOnlySharedConversation ? (
                <div className="sticky bottom-0 bg-background border-t p-4">
                  <div className="max-w-4xl mx-auto space-y-3">
                    <div className="relative">
                      <div className="border-input dark:bg-input/30 relative flex w-full flex-col rounded-md border shadow-xs opacity-30 blur-[3px] pointer-events-none select-none">
                        <div className="px-4 py-5 min-h-[120px]">
                          <span className="text-sm text-muted-foreground">
                            Type a message...
                          </span>
                        </div>
                        <div className="flex items-center justify-between w-full px-3 pb-3">
                          <div className="flex items-center gap-1">
                            <div className="size-8 flex items-center justify-center">
                              <PaperclipIcon className="size-4 text-muted-foreground" />
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="size-8 flex items-center justify-center">
                              <MicIcon className="size-4 text-muted-foreground" />
                            </div>
                            <div className="size-8 flex items-center justify-center rounded-md bg-primary">
                              <CornerDownLeftIcon className="size-4 text-primary-foreground" />
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-auto">
                        <Button
                          onClick={() => {
                            if (shouldPromptForForkAgentSelection) {
                              setIsForkDialogOpen(true);
                              return;
                            }

                            void handleForkSharedConversation();
                          }}
                        >
                          <Plus className="h-4 w-4 mr-2" />
                          Start New Chat from here
                        </Button>
                      </div>
                    </div>
                    <div className="text-center">
                      <Version inline />
                    </div>
                  </div>
                </div>
              ) : isAgentDeleted ? (
                <div className="sticky bottom-0 bg-background border-t p-4">
                  <div className="max-w-4xl mx-auto">
                    <div className="flex items-center justify-between gap-4 p-4 rounded-lg border border-muted bg-muted/50">
                      <div className="flex items-center gap-3 text-muted-foreground">
                        <AlertTriangle className="h-5 w-5 text-amber-500" />
                        <span>
                          The agent associated with this conversation has been
                          deleted.
                        </span>
                      </div>
                      <Button onClick={() => router.push("/chat")}>
                        <Plus className="h-4 w-4 mr-2" />
                        New Conversation
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                activeAgentId && (
                  <div className="sticky bottom-0 bg-background border-t p-4">
                    <div className="max-w-4xl mx-auto space-y-3">
                      <ArchestraPromptInput
                        onSubmit={handleSubmit}
                        status={status}
                        selectedModel={conversation?.selectedModel ?? ""}
                        onModelChange={handleModelChange}
                        agentId={promptAgentId ?? activeAgentId}
                        conversationId={conversationId}
                        currentConversationChatApiKeyId={
                          conversation?.chatApiKeyId
                        }
                        currentProvider={currentProvider}
                        textareaRef={textareaRef}
                        onProviderChange={handleProviderChange}
                        allowFileUploads={
                          organization?.allowChatFileUploads ?? false
                        }
                        isModelsLoading={isModelsLoading}
                        tokensUsed={tokensUsed}
                        maxContextLength={selectedModelContextLength}
                        inputModalities={selectedModelInputModalities}
                        agentLlmApiKeyId={
                          conversation?.agent?.llmApiKeyId ?? null
                        }
                        submitDisabled={isPlaywrightSetupVisible}
                        isPlaywrightSetupVisible={isPlaywrightSetupVisible}
                        selectorAgentId={activeAgentId}
                        selectorAgentName={swappedAgentName ?? undefined}
                        onAgentChange={handleConversationAgentChange}
                        modelSource={conversationModelSource}
                        onResetModelOverride={
                          handleConversationResetModelOverride
                        }
                      />
                      <div className="text-center">
                        <Version inline />
                      </div>
                    </div>
                  </div>
                )
              )}
            </>
          ) : (
            /* No active chat: centered prompt input */
            newChatAgentId && (
              // biome-ignore lint/a11y/noStaticElementInteractions: click-to-focus container
              // biome-ignore lint/a11y/useKeyWithClickEvents: click-to-focus container
              <div
                className="relative flex-1 flex flex-col min-h-0"
                onClick={(e) => {
                  // Focus textarea when clicking empty space outside interactive elements
                  if (
                    e.target === e.currentTarget ||
                    !(e.target as HTMLElement).closest(
                      "button, a, input, textarea, [role=combobox], [data-slot=input-group]",
                    )
                  ) {
                    textareaRef.current?.focus();
                  }
                }}
              >
                {((organization?.chatLinks?.length ?? 0) > 0 ||
                  organization?.onboardingWizard) && (
                  <div className="absolute top-4 right-4 z-10 flex flex-wrap justify-end gap-2 max-w-[min(100%,36rem)]">
                    {organization?.chatLinks?.map((link) => (
                      <ChatLinkButton
                        key={`link-${link.label}-${link.url}`}
                        url={link.url}
                        label={link.label}
                      />
                    ))}
                    {organization?.onboardingWizard && (
                      <OnboardingWizardButton
                        wizard={organization.onboardingWizard}
                      />
                    )}
                  </div>
                )}
                {isPlaywrightSetupRequired && canUpdateAgent && (
                  <PlaywrightInstallDialog
                    agentId={playwrightSetupAgentId}
                    conversationId={conversationId}
                  />
                )}
                <div className="flex-1 flex flex-col items-center justify-center p-4 gap-8">
                  <div className="scale-150">
                    <AppLogo />
                  </div>
                  {(() => {
                    const currentAgent = internalAgents.find(
                      (a) => a.id === initialAgentId,
                    );
                    const prompts = currentAgent?.suggestedPrompts;
                    if (!prompts || prompts.length === 0) return null;
                    return (
                      <div className="flex flex-wrap items-center justify-center gap-2 max-w-2xl">
                        {prompts.map((sp) => (
                          <Suggestion
                            key={`${sp.summaryTitle}-${sp.prompt}`}
                            suggestion={sp.summaryTitle}
                            onClick={() =>
                              submitInitialMessage({
                                text: sp.prompt,
                                files: [],
                              })
                            }
                          />
                        ))}
                      </div>
                    );
                  })()}
                  <div className="w-full max-w-4xl">
                    <ArchestraPromptInput
                      onSubmit={handleInitialSubmit}
                      status={
                        createConversationMutation.isPending
                          ? "submitted"
                          : "ready"
                      }
                      selectedModel={initialModel}
                      onModelChange={handleInitialModelChange}
                      onModelSelectorOpenChange={
                        handleInitialModelSelectorOpenChange
                      }
                      agentId={newChatAgentId}
                      currentProvider={initialProvider}
                      textareaRef={textareaRef}
                      initialApiKeyId={initialApiKeyId}
                      onApiKeyChange={setInitialApiKeyId}
                      onProviderChange={handleInitialProviderChange}
                      allowFileUploads={
                        organization?.allowChatFileUploads ?? false
                      }
                      isModelsLoading={isModelsLoading}
                      inputModalities={selectedModelInputModalities}
                      agentLlmApiKeyId={
                        (
                          internalAgents.find((a) => a.id === initialAgentId) as
                            | Record<string, unknown>
                            | undefined
                        )?.llmApiKeyId as string | null
                      }
                      submitDisabled={isPlaywrightSetupVisible}
                      isPlaywrightSetupVisible={isPlaywrightSetupVisible}
                      selectorAgentId={initialAgentId}
                      onAgentChange={handleInitialAgentChange}
                      modelSource={initialModelSource}
                      onResetModelOverride={handleResetModelOverride}
                    />
                  </div>
                </div>
                <div className="p-4 text-center">
                  <Version inline />
                </div>
              </div>
            )
          )}
        </div>
      </div>

      {/* Right-side panel - desktop only */}
      <div className="hidden md:flex">
        <RightSidePanel
          artifact={conversation?.artifact}
          isArtifactOpen={isArtifactOpen}
          onArtifactToggle={toggleArtifactPanel}
          isBrowserOpen={isBrowserPanelOpen && !isPlaywrightSetupVisible}
          onBrowserClose={closeBrowserPanel}
          conversationId={conversationId}
          agentId={browserToolsAgentId}
          onCreateConversationWithUrl={handleCreateConversationWithUrl}
          isCreatingConversation={createConversationMutation.isPending}
          initialNavigateUrl={pendingBrowserUrl}
          onInitialNavigateComplete={handleInitialNavigateComplete}
        />
      </div>

      <CustomServerRequestDialog
        isOpen={isDialogOpened("custom-request")}
        onClose={() => closeDialog("custom-request")}
      />
      <CreateCatalogDialog
        isOpen={isDialogOpened("create-catalog")}
        onClose={() => closeDialog("create-catalog")}
        onSuccess={() => router.push("/mcp/registry")}
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

      {canManageShare && conversationId && (
        <ShareConversationDialog
          conversationId={conversationId}
          open={isShareDialogOpen}
          onOpenChange={setIsShareDialogOpen}
        />
      )}

      <StandardDialog
        open={isForkDialogOpen}
        onOpenChange={setIsForkDialogOpen}
        title="Start New Chat"
        description={
          shouldPromptForForkAgentSelection
            ? "The original agent is not available to you. Select another agent to start a new chat with the preloaded messages from this conversation."
            : "Select an agent to start a new chat with the preloaded messages from this conversation."
        }
        size="small"
        bodyClassName="py-1"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setIsForkDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleForkSharedConversation}
              disabled={
                !effectiveForkAgentId ||
                forkSharedConversationMutation.isPending
              }
            >
              {forkSharedConversationMutation.isPending
                ? "Creating..."
                : "Start Chat"}
            </Button>
          </>
        }
      >
        <InitialAgentSelector
          currentAgentId={forkAgentId}
          onAgentChange={setForkAgentId}
        />
      </StandardDialog>
    </div>
  );
}
