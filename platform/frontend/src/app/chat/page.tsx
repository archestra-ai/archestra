"use client";

import type { UIMessage } from "@ai-sdk/react";
import { E2eTestId } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  CornerDownLeftIcon,
  FileText,
  Globe,
  MicIcon,
  MoreVertical,
  PaperclipIcon,
  Plus,
  Share2,
  Users,
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
import type {
  PromptInputMessage,
  PromptInputProps,
} from "@/components/ai-elements/prompt-input";
import { Suggestion } from "@/components/ai-elements/suggestion";
import { AppLogo } from "@/components/app-logo";
import { ButtonWithTooltip } from "@/components/button-with-tooltip";
import { BrowserPanel } from "@/components/chat/browser-panel";
import { ChatLinkButton } from "@/components/chat/chat-help-link";
import { ChatMessages } from "@/components/chat/chat-messages";
import { ConversationArtifactPanel } from "@/components/chat/conversation-artifact";
import { InitialAgentSelector } from "@/components/chat/initial-agent-selector";
import { OnboardingWizardButton } from "@/components/chat/onboarding-wizard-button";
import {
  PlaywrightInstallDialog,
  usePlaywrightSetupRequired,
} from "@/components/chat/playwright-install-dialog";
import { RightSidePanel } from "@/components/chat/right-side-panel";
import { ShareConversationDialog } from "@/components/chat/share-conversation-dialog";
import { StreamTimeoutWarning } from "@/components/chat/stream-timeout-warning";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import type { LlmProviderApiKeyFormValues } from "@/components/llm-provider-api-key-form";
import { LoadingSpinner } from "@/components/loading";
import MessageThread, {
  type PartialUIMessage,
} from "@/components/message-thread";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import { TypingText } from "@/components/ui/typing-text";
import { Version } from "@/components/version";
import { useDefaultAgentId, useInternalAgents } from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  clearOAuthReauthChatResume,
  getOAuthReauthChatResume,
} from "@/lib/auth/oauth-session";
import { useRecentlyGeneratedTitles } from "@/lib/chat/chat.hook";
import {
  fetchConversationEnabledTools,
  useConversation,
  useCreateConversation,
  useHasPlaywrightMcpTools,
  useStopChatStream,
  useUpdateConversation,
  useUpdateConversationEnabledTools,
} from "@/lib/chat/chat.query";
import { useChatAgentState } from "@/lib/chat/chat-agent-state.hook";
import {
  useConversationShare,
  useForkSharedConversation,
} from "@/lib/chat/chat-share.query";
import {
  conversationStorageKeys,
  getConversationDisplayTitle,
} from "@/lib/chat/chat-utils";
import { useChatSession } from "@/lib/chat/global-chat.context";
import {
  applyPendingActions,
  clearPendingActions,
  getPendingActions,
} from "@/lib/chat/pending-tool-state";
import {
  clearModelOverride,
  getSavedAgent,
  getSavedModelOverride,
  type ModelSource,
  saveAgent,
  saveModelOverride,
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
import {
  buildCreateConversationInput,
  resolveChatModelState,
  resolveInitialAgentSelection,
  resolveInitialAgentState,
  resolvePreferredModelForProvider,
  shouldResetInitialChatState,
} from "./chat-initial-state";
import ArchestraPromptInput from "./prompt-input";
import { resolveSharedConversationForkState } from "./shared-conversation-fork";

const BROWSER_OPEN_KEY = "archestra-chat-browser-open";

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
  const [isArtifactOpen, setIsArtifactOpen] = useState(false);
  const pendingPromptRef = useRef<string | undefined>(undefined);
  const pendingFilesRef = useRef<
    Array<{ url: string; mediaType: string; filename?: string }>
  >([]);
  const userMessageJustEdited = useRef(false);
  const pendingInitialSendConversationRef = useRef<string | undefined>(
    undefined,
  );
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const autoSendTriggeredRef = useRef(false);
  const oauthReauthResumeTriggeredRef = useRef(false);
  // Store pending URL for browser navigation after conversation is created
  const [pendingBrowserUrl, setPendingBrowserUrl] = useState<
    string | undefined
  >(undefined);

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
  const { data: canReadTeams } = useHasPermissions({
    team: ["read"],
  });
  const { data: canUpdateAgent } = useHasPermissions({
    agent: ["team-admin"],
  });
  const { data: canSeeAgentPicker, isLoading: isAgentPickerPermissionLoading } =
    useHasPermissions({
      chatAgentPicker: ["enable"],
    });
  const { data: teams } = useTeams({ enabled: !!canReadTeams });

  // Non-admin users with no teams cannot create agents
  const cannotCreateDueToNoTeams =
    !isAgentAdmin && (!teams || teams.length === 0);

  const _isMobile = useIsMobile();

  // State for browser panel - initialize from localStorage
  const [isBrowserPanelOpen, setIsBrowserPanelOpen] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(BROWSER_OPEN_KEY) === "true";
    }
    return false;
  });

  const hasChatAccess = canReadAgent !== false;
  const canUseProviderSettings =
    canReadLlmProvider === true && canReadLlmModels === true;

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

  // State for initial chat (when no conversation exists yet)
  const [initialAgentId, setInitialAgentId] = useState<string | null>(null);
  const [initialModel, setInitialModel] = useState<string>("");
  const [initialApiKeyId, setInitialApiKeyId] = useState<string | null>(null);
  const [initialModelSource, setInitialModelSource] =
    useState<ModelSource | null>(null);
  const previousRouteConversationIdRef = useRef<string | undefined>(
    routeConversationId,
  );
  // Track which agentId URL param has been consumed (so we don't re-apply the same one after user clears selection,
  // but do apply a new one when navigating from a different agent page)
  const urlParamsConsumedRef = useRef<string | null>(null);

  // Resolve which agent to use on page load (URL param > localStorage > first available).
  // Stores the resolved agent in a ref so the model init effect can read it synchronously.
  const resolvedAgentRef = useRef<(typeof internalAgents)[number] | null>(null);

  const applyInitialAgentSelection = useCallback(
    (agent: (typeof internalAgents)[number]) => {
      setInitialAgentId(agent.id);
      resolvedAgentRef.current = agent;

      const resolved = resolveInitialAgentState({
        agent,
        modelsByProvider,
        chatApiKeys,
        organization: organization
          ? {
              defaultLlmModel: organization.defaultLlmModel,
              defaultLlmApiKeyId: organization.defaultLlmApiKeyId,
            }
          : null,
      });

      if (resolved) {
        setInitialModel(resolved.modelId);
        setInitialApiKeyId(resolved.apiKeyId);
        setInitialModelSource(resolved.modelSource);
      } else {
        setInitialModel("");
        setInitialApiKeyId(null);
        setInitialModelSource(null);
      }
    },
    [modelsByProvider, chatApiKeys, organization],
  );

  useEffect(() => {
    if (internalAgents.length === 0) return;
    // Wait for organization data to avoid race condition where agents load
    // before org, causing the org default to be skipped
    if (isOrgLoading) return;

    // Process URL agentId param, but only if it's a new value (not one we already consumed).
    // This allows navigating from different agent pages while preventing re-application
    // after the user manually changes the agent.
    const urlAgentId = searchParams.get("agentId");
    if (urlAgentId && urlAgentId !== urlParamsConsumedRef.current) {
      const matchingAgent = internalAgents.find((a) => a.id === urlAgentId);
      if (matchingAgent) {
        applyInitialAgentSelection(matchingAgent);
        urlParamsConsumedRef.current = urlAgentId;
        return;
      }
    }

    // Priority: org default > localStorage > member default > first available.
    // Org default always wins when set (admin-configured for the whole org).
    // localStorage only overrides when no org default is configured and the
    // user can change agents; otherwise a stale hidden picker value can trap
    // restricted users on a previously swapped agent.
    // Also skip if a URL param was consumed but state hasn't flushed yet.
    if (!initialAgentId && !urlParamsConsumedRef.current) {
      if (isAgentPickerPermissionLoading) return;

      const selectedAgent = resolveInitialAgentSelection({
        agents: internalAgents,
        organizationDefaultAgentId: organization?.defaultAgentId,
        savedAgentId: getSavedAgent(),
        memberDefaultAgentId: defaultAgentId,
        canUseSavedAgent: canSeeAgentPicker === true,
      });
      if (!selectedAgent) return;

      applyInitialAgentSelection(selectedAgent);
      saveAgent(selectedAgent.id);
    }
  }, [
    applyInitialAgentSelection,
    initialAgentId,
    searchParams,
    internalAgents,
    defaultAgentId,
    organization?.defaultAgentId,
    isOrgLoading,
    canSeeAgentPicker,
    isAgentPickerPermissionLoading,
  ]);

  // Initialize model and API key once agent is resolved.
  // Priority: agent config > org default > first available.
  // Uses modelInitializedRef instead of checking initialModel to avoid a race condition:
  // ModelSelector's auto-select fires before this effect and sets initialModel, which would
  // cause an early return and skip the proper priority chain (org default, etc.).
  const modelInitializedRef = useRef(false);
  useEffect(() => {
    if (!initialAgentId) return;
    if (modelInitializedRef.current) return;

    const resolved = resolveChatModelState({
      agent: resolvedAgentRef.current,
      modelsByProvider,
      chatApiKeys,
      organization: organization
        ? {
            defaultLlmModel: organization.defaultLlmModel,
            defaultLlmApiKeyId: organization.defaultLlmApiKeyId,
          }
        : null,
    });

    if (!resolved) return; // No models available yet

    setInitialModel(resolved.modelId);
    setInitialModelSource(resolved.modelSource);
    if (resolved.apiKeyId) {
      setInitialApiKeyId(resolved.apiKeyId);
    }
    modelInitializedRef.current = true;
  }, [
    initialAgentId,
    modelsByProvider,
    chatApiKeys,
    organization?.defaultLlmModel,
    organization?.defaultLlmApiKeyId,
    organization,
  ]);

  // Model change callback for the initial (no conversation) state.
  // After init, only accept explicit user selections (dialog was opened).
  // This prevents ModelSelector's auto-select (triggered by apiKeyId changes)
  // from overwriting the agent default or org default.
  const modelSelectorWasOpenRef = useRef(false);
  const handleInitialModelChange = useCallback((modelId: string) => {
    if (modelInitializedRef.current && !modelSelectorWasOpenRef.current) {
      return;
    }
    setInitialModel(modelId);
    if (modelSelectorWasOpenRef.current) {
      setInitialModelSource("user");
      saveModelOverride(modelId);
    }
    modelSelectorWasOpenRef.current = false;
  }, []);
  const handleInitialModelSelectorOpenChange = useCallback((open: boolean) => {
    if (open) {
      modelSelectorWasOpenRef.current = true;
    }
  }, []);

  // Handle API key change - preselect best model for the new key's provider
  const handleInitialProviderChange = useCallback(
    (newProvider: SupportedProvider, _apiKeyId: string) => {
      const preferredModel = resolvePreferredModelForProvider({
        provider: newProvider,
        modelsByProvider,
      });
      if (preferredModel) {
        setInitialModel(preferredModel.modelId);
        setInitialModelSource("user");
        saveModelOverride(preferredModel.modelId);
      }
    },
    [modelsByProvider],
  );

  // Reset model override: clear localStorage and re-resolve from agent/org defaults
  const handleResetModelOverride = useCallback(() => {
    clearModelOverride();
    modelInitializedRef.current = false;

    const resolved = resolveChatModelState({
      agent: resolvedAgentRef.current,
      modelsByProvider,
      chatApiKeys,
      organization: organization
        ? {
            defaultLlmModel: organization.defaultLlmModel,
            defaultLlmApiKeyId: organization.defaultLlmApiKeyId,
          }
        : null,
    });

    if (resolved) {
      setInitialModel(resolved.modelId);
      setInitialApiKeyId(resolved.apiKeyId);
      setInitialModelSource(resolved.modelSource);
    }
    modelInitializedRef.current = true;
  }, [modelsByProvider, chatApiKeys, organization]);

  // Derive provider from initial model for API key filtering
  const initialProvider = useMemo((): SupportedProvider | undefined => {
    if (!initialModel) return undefined;
    for (const [provider, models] of Object.entries(modelsByProvider)) {
      if (models?.some((m) => m.id === initialModel)) {
        return provider as SupportedProvider;
      }
    }
    return undefined;
  }, [initialModel, modelsByProvider]);

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
      setInitialAgentId(null);
      setInitialModel("");
      setInitialApiKeyId(null);
      setInitialModelSource(null);
      modelInitializedRef.current = false;
    }

    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [routeConversationId]);

  // Get user_prompt from URL for auto-sending
  const initialUserPrompt = useMemo(() => {
    return searchParams.get("user_prompt") || undefined;
  }, [searchParams]);

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

  // Fetch conversation with messages
  const { data: conversation, isLoading: isLoadingConversation } =
    useConversation(conversationId);
  const canManageShare =
    !!conversationId &&
    !!conversation &&
    conversation.userId === session?.user.id;
  useConversationShare(canManageShare ? conversationId : undefined);
  const isShared = !!conversation?.share;
  const isReadOnlySharedConversation =
    !!conversationId &&
    !!conversation?.share &&
    conversation.userId !== session?.user.id;
  const persistedConversationMessages = useMemo(
    () => (conversation?.messages ?? []) as UIMessage[],
    [conversation?.messages],
  );
  const shouldEnableChatSession =
    !!conversationId &&
    !isReadOnlySharedConversation &&
    (!routeConversationId || !!conversation);
  const chatSession = useChatSession({
    conversationId: shouldEnableChatSession ? conversationId : undefined,
    initialMessages: persistedConversationMessages,
    enabled: shouldEnableChatSession,
  });
  const sharedConversationMessages = useMemo(
    () => (conversation?.messages ?? []) as PartialUIMessage[],
    [conversation?.messages],
  );
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

  // Initialize artifact panel state when conversation loads or changes
  useEffect(() => {
    // If no conversation (new chat), close the artifact panel
    if (!conversationId) {
      setIsArtifactOpen(false);
      return;
    }

    if (isLoadingConversation) return;

    // Check for conversation-specific preference
    const { artifactOpen: artifactOpenKey } =
      conversationStorageKeys(conversationId);
    const storedState = localStorage.getItem(artifactOpenKey);
    if (storedState !== null) {
      // User has explicitly set a preference for this conversation
      setIsArtifactOpen(storedState === "true");
    } else if (conversation?.artifact) {
      // First time viewing this conversation with an artifact - auto-open
      setIsArtifactOpen(true);
      localStorage.setItem(artifactOpenKey, "true");
    } else {
      // No artifact or no stored preference - keep closed
      setIsArtifactOpen(false);
    }
  }, [conversationId, conversation?.artifact, isLoadingConversation]);

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
      localStorage.setItem(
        conversationStorageKeys(conversationId).artifactOpen,
        String(newValue),
      );
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
      localStorage.setItem(
        conversationStorageKeys(conversationId).artifactOpen,
        "true",
      );
    }

    // Update the ref for next comparison
    previousArtifactRef.current = conversation?.artifact;
  }, [conversation?.artifact, isArtifactOpen, conversationId]);

  // While a conversation tab is open, useChat owns the thread.
  // We only fall back to persisted messages before the session initializes or
  // for read-only shared conversations that do not create a live chat session.
  const messages = useMemo(
    () =>
      chatSession?.messages
        ? mergePersistedMessageMetadata({
            liveMessages: chatSession.messages,
            persistedMessages: persistedConversationMessages,
          })
        : persistedConversationMessages,
    [chatSession?.messages, persistedConversationMessages],
  );
  const sendMessage = chatSession?.sendMessage;
  const status = chatSession?.status ?? "ready";
  const setMessages = chatSession?.setMessages;
  const stop = chatSession?.stop;
  const error =
    status === "submitted" || status === "streaming"
      ? undefined
      : chatSession?.error;
  const addToolResult = chatSession?.addToolResult;
  const addToolApprovalResponse = chatSession?.addToolApprovalResponse;
  const pendingCustomServerToolCall = chatSession?.pendingCustomServerToolCall;
  const optimisticToolCalls = chatSession?.optimisticToolCalls ?? [];
  const setPendingCustomServerToolCall =
    chatSession?.setPendingCustomServerToolCall;
  const tokenUsage = chatSession?.tokenUsage;

  const {
    conversationAgentId,
    activeAgentId,
    promptAgentId,
    swappedAgentName,
  } = useChatAgentState({
    conversation,
    initialAgentId,
    messages,
    agents: internalAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
    })),
  });
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

  // Send a deferred initial prompt once the newly-created conversation's chat
  // session is ready. Existing conversations seed useChat with persisted
  // messages, so we do not rehydrate them via setMessages here.
  useEffect(() => {
    if (!setMessages || !sendMessage) {
      return;
    }

    // Clear the edit flag when status changes to ready (streaming finished)
    if (status === "ready" && userMessageJustEdited.current) {
      userMessageJustEdited.current = false;
    }

    const hasPendingInitialMessage =
      !!pendingPromptRef.current || pendingFilesRef.current.length > 0;
    const shouldSendPendingInitialMessage =
      conversationId &&
      conversation?.id === conversationId &&
      conversation.messages.length === 0 &&
      messages.length === 0 &&
      status === "ready" &&
      hasPendingInitialMessage &&
      pendingInitialSendConversationRef.current !== conversationId;

    if (!shouldSendPendingInitialMessage) {
      return;
    }

    pendingInitialSendConversationRef.current = conversationId;
    const promptToSend = pendingPromptRef.current;
    const filesToSend = pendingFilesRef.current;
    pendingPromptRef.current = undefined;
    pendingFilesRef.current = [];

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
      metadata: { createdAt: new Date().toISOString() },
    });
  }, [
    conversation,
    conversationId,
    messages.length,
    sendMessage,
    setMessages,
    status,
  ]);

  // Poll for the assistant response when the page was reloaded mid-stream.
  // After reload the DB may only contain the user message (persisted early by
  // the backend). The assistant response arrives once the backend stream
  // finishes. We poll until the last message is no longer a user message.
  useEffect(() => {
    if (!conversationId || status === "streaming" || status === "submitted") {
      return;
    }

    const lastMsg = conversation?.messages?.at(-1) as UIMessage | undefined;
    const isWaitingForAssistant =
      lastMsg?.role === "user" && messages.length > 0;

    if (!isWaitingForAssistant) return;

    const interval = setInterval(() => {
      queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });
    }, 3000);

    return () => clearInterval(interval);
  }, [
    conversationId,
    conversation?.messages,
    messages.length,
    status,
    queryClient,
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

  // Persist browser panel state - just opens panel, installation happens inside if needed
  const toggleBrowserPanel = useCallback(() => {
    const newValue = !isBrowserPanelOpen;
    setIsBrowserPanelOpen(newValue);
    localStorage.setItem(BROWSER_OPEN_KEY, String(newValue));
  }, [isBrowserPanelOpen]);

  // Close browser panel handler (also persists to localStorage)
  const closeBrowserPanel = useCallback(() => {
    setIsBrowserPanelOpen(false);
    localStorage.setItem(BROWSER_OPEN_KEY, "false");
  }, []);

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
    [createInitialConversation, selectConversation],
  );

  // Callback to clear pending browser URL after navigation completes
  const handleInitialNavigateComplete = useCallback(() => {
    setPendingBrowserUrl(undefined);
  }, []);

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

  // Handle initial agent change (when no conversation exists)
  const handleInitialAgentChange = useCallback(
    (agentId: string) => {
      setInitialAgentId(agentId);
      saveAgent(agentId);

      // Resolve model/key for the new agent using the same priority chain
      const selectedAgent = internalAgents.find((a) => a.id === agentId);
      if (selectedAgent) {
        applyInitialAgentSelection(selectedAgent);
      }
    },
    [applyInitialAgentSelection, internalAgents],
  );

  // Core logic for starting a new conversation with a message
  const submitInitialMessage = useCallback(
    (message: Partial<PromptInputMessage>) => {
      if (isPlaywrightSetupVisible) return;
      const hasText = message.text?.trim();
      const hasFiles = message.files && message.files.length > 0;

      if (
        (!hasText && !hasFiles) ||
        !initialAgentId ||
        createConversationMutation.isPending
      ) {
        return;
      }

      // Store the message (text and files) to send after conversation is created
      pendingPromptRef.current = message.text || "";
      pendingFilesRef.current = message.files || [];

      // Check if there are pending tool actions to apply
      const pendingActions = getPendingActions(initialAgentId);

      createInitialConversation(async (newConversation) => {
        // Apply pending tool actions if any
        if (pendingActions.length > 0) {
          // Get the default enabled tools from the conversation (backend sets these)
          // We need to fetch them first to apply our pending actions on top
          try {
            // The backend creates conversation with default enabled tools
            // We need to apply pending actions to modify that default
            const enabledToolsResult = await fetchConversationEnabledTools(
              newConversation.id,
            );
            if (enabledToolsResult?.data) {
              const baseEnabledToolIds =
                enabledToolsResult.data.enabledToolIds || [];
              const newEnabledToolIds = applyPendingActions(
                baseEnabledToolIds,
                pendingActions,
              );

              // Pre-populate the query cache so useConversationEnabledTools
              // immediately sees the correct state when conversationId is set.
              // Without this, the hook would briefly see default data (with
              // Playwright tools still enabled) causing flickering.
              queryClient.setQueryData(
                ["conversation", newConversation.id, "enabled-tools"],
                {
                  hasCustomSelection: true,
                  enabledToolIds: newEnabledToolIds,
                },
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
      });
    },
    [
      isPlaywrightSetupVisible,
      initialAgentId,
      createInitialConversation,
      updateEnabledToolsMutation,
      selectConversation,
      queryClient,
      createConversationMutation.isPending,
    ],
  );

  // Form submit handler wraps submitInitialMessage with event.preventDefault
  const handleInitialSubmit: PromptInputProps["onSubmit"] = useCallback(
    (message, e) => {
      e.preventDefault();
      submitInitialMessage(message);
    },
    [submitInitialMessage],
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

    createInitialConversation((newConversation) => {
      selectConversation(newConversation.id);
    });
  }, [
    initialUserPrompt,
    conversationId,
    initialAgentId,
    createInitialConversation,
    selectConversation,
    createConversationMutation.isPending,
  ]);

  useEffect(() => {
    const pendingReauthResume = getOAuthReauthChatResume();
    if (
      oauthReauthResumeTriggeredRef.current ||
      !pendingReauthResume ||
      pendingReauthResume.conversationId !== conversationId ||
      !sendMessage ||
      status !== "ready"
    ) {
      return;
    }

    oauthReauthResumeTriggeredRef.current = true;
    clearOAuthReauthChatResume();
    sendMessage({
      role: "user",
      parts: [{ type: "text", text: pendingReauthResume.message }],
      metadata: { createdAt: new Date().toISOString() },
    });
  }, [conversationId, sendMessage, status]);

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

          <div
            className={cn(
              "sticky top-0 z-10 bg-background border-b p-2",
              !conversationId && "hidden",
            )}
          >
            <div className="relative flex items-center justify-between gap-2">
              {/* Left side - conversation title */}
              {conversationId && conversation && (
                <div className="flex items-center flex-shrink min-w-0">
                  <TruncatedTooltip
                    content={getConversationDisplayTitle(
                      conversation.title,
                      conversation.messages,
                    )}
                  >
                    <h1 className="text-base font-normal text-muted-foreground truncate max-w-[360px] cursor-default">
                      {headerAnimatingTitles.has(conversation.id) ? (
                        <TypingText
                          text={getConversationDisplayTitle(
                            conversation.title,
                            conversation.messages,
                          )}
                          typingSpeed={35}
                          showCursor
                          cursorClassName="bg-muted-foreground"
                        />
                      ) : (
                        getConversationDisplayTitle(
                          conversation.title,
                          conversation.messages,
                        )
                      )}
                    </h1>
                  </TruncatedTooltip>
                </div>
              )}
              {/* Right side - desktop: original buttons */}
              <div className="hidden md:flex items-center gap-2 flex-shrink-0">
                {canManageShare && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsShareDialogOpen(true)}
                    className="text-xs"
                  >
                    {isShared ? (
                      <>
                        <Users className="h-3 w-3 mr-1 text-primary" />
                        <span className="text-primary">Shared</span>
                      </>
                    ) : (
                      <>
                        <Share2 className="h-3 w-3 mr-1" />
                        Share
                      </>
                    )}
                  </Button>
                )}
                {canManageShare && <div className="w-px h-4 bg-border" />}
                <Button
                  variant={isArtifactOpen ? "secondary" : "ghost"}
                  size="sm"
                  onClick={toggleArtifactPanel}
                  className="text-xs"
                >
                  <FileText className="h-3 w-3 mr-1" />
                  Artifact
                </Button>

                {showBrowserButton && (
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
              {/* Right side - mobile: 3-dot dropdown */}
              <div className="flex md:hidden items-center gap-2 flex-shrink-0">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      title="More options"
                    >
                      <MoreVertical className="h-4 w-4" />
                      <span className="sr-only">More options</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {canManageShare && (
                      <DropdownMenuItem
                        onSelect={() => setIsShareDialogOpen(true)}
                      >
                        {isShared ? (
                          <>
                            <Users className="h-4 w-4 text-primary" />
                            <span className="text-primary">Shared</span>
                          </>
                        ) : (
                          <>
                            <Share2 className="h-4 w-4" />
                            Share
                          </>
                        )}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={toggleArtifactPanel}>
                      <FileText className="h-4 w-4" />
                      {isArtifactOpen ? "Hide Artifact" : "Show Artifact"}
                    </DropdownMenuItem>
                    {showBrowserButton && (
                      <DropdownMenuItem
                        onSelect={toggleBrowserPanel}
                        disabled={isPlaywrightSetupVisible}
                      >
                        <Globe className="h-4 w-4" />
                        {isBrowserPanelOpen && !isPlaywrightSetupVisible
                          ? "Hide Browser"
                          : "Show Browser"}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>

          {/* Mobile: Inline artifact/browser panels below header */}
          {(isArtifactOpen ||
            (isBrowserPanelOpen && !isPlaywrightSetupVisible)) && (
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden md:hidden">
              {isArtifactOpen && (
                <div
                  className={cn(
                    "min-h-0 overflow-auto",
                    isBrowserPanelOpen && !isPlaywrightSetupVisible
                      ? "h-1/2 border-b"
                      : "flex-1",
                  )}
                >
                  <ConversationArtifactPanel
                    artifact={conversation?.artifact}
                    isOpen={isArtifactOpen}
                    onToggle={toggleArtifactPanel}
                    embedded
                  />
                </div>
              )}
              {isBrowserPanelOpen && !isPlaywrightSetupVisible && (
                <div
                  className={cn(
                    "min-h-0 overflow-auto",
                    isArtifactOpen ? "h-1/2" : "flex-1",
                  )}
                >
                  <BrowserPanel
                    isOpen={true}
                    onClose={closeBrowserPanel}
                    conversationId={conversationId}
                    agentId={browserToolsAgentId}
                    onCreateConversationWithUrl={
                      handleCreateConversationWithUrl
                    }
                    isCreatingConversation={
                      createConversationMutation.isPending
                    }
                    initialNavigateUrl={pendingBrowserUrl}
                    onInitialNavigateComplete={handleInitialNavigateComplete}
                  />
                </div>
              )}
            </div>
          )}

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

export default function ChatPage() {
  return <ChatPageContent key="new-chat" />;
}

function mergePersistedMessageMetadata(params: {
  liveMessages: UIMessage[];
  persistedMessages: UIMessage[];
}): UIMessage[] {
  const remainingPersistedMessages = [...params.persistedMessages];

  return params.liveMessages.map((liveMessage) => {
    if (hasCreatedAtMetadata(liveMessage)) {
      return liveMessage;
    }

    const persistedIndex = remainingPersistedMessages.findIndex(
      (persistedMessage) =>
        messagesHaveSameRenderableContent({
          liveMessage,
          persistedMessage,
        }),
    );

    if (persistedIndex === -1) {
      return liveMessage;
    }

    const [persistedMessage] = remainingPersistedMessages.splice(
      persistedIndex,
      1,
    );

    return {
      ...liveMessage,
      metadata: {
        ...getObjectMetadata(persistedMessage),
        ...getObjectMetadata(liveMessage),
      },
    };
  });
}

function messagesHaveSameRenderableContent(params: {
  liveMessage: UIMessage;
  persistedMessage: UIMessage;
}) {
  return (
    params.liveMessage.role === params.persistedMessage.role &&
    getMessageText(params.liveMessage) ===
      getMessageText(params.persistedMessage)
  );
}

function getMessageText(message: UIMessage) {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function hasCreatedAtMetadata(message: UIMessage) {
  const metadata = getObjectMetadata(message);
  return typeof metadata.createdAt === "string";
}

function getObjectMetadata(message: UIMessage): Record<string, unknown> {
  return typeof message.metadata === "object" && message.metadata !== null
    ? { ...message.metadata }
    : {};
}

// =========================================================================
// No API Key Setup — shown when user has no API keys configured
// =========================================================================

const DEFAULT_FORM_VALUES: LlmProviderApiKeyFormValues = {
  name: "",
  provider: "anthropic",
  apiKey: null,
  baseUrl: null,
  extraHeaders: [],
  scope: "personal",
  teamId: null,
  vaultSecretPath: null,
  vaultSecretKey: null,
  isPrimary: true,
};

function NoApiKeySetup() {
  const router = useRouter();
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="text-center space-y-4">
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">Add an LLM Provider Key</h2>
          <p className="text-sm text-muted-foreground">
            Connect an LLM provider to start chatting
          </p>
        </div>
        <Button
          data-testid={E2eTestId.QuickstartAddApiKeyButton}
          onClick={() => setIsDialogOpen(true)}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add API Key
        </Button>
      </div>
      <CreateLlmProviderApiKeyDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title="Add API Key"
        description="Add an LLM provider API key to start chatting"
        defaultValues={DEFAULT_FORM_VALUES}
        showConsoleLink
        onSuccess={() => {
          // Navigate to clean /chat URL so there's no stale conversation param
          router.push("/chat");
        }}
      />
    </div>
  );
}
