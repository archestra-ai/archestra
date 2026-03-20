"use client";

import type { UIMessage } from "@ai-sdk/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  FileText,
  Globe,
  MoreVertical,
  Plus,
  Share2,
  Users,
} from "lucide-react";
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
import {
  PlaywrightInstallDialog,
  usePlaywrightSetupRequired,
} from "@/components/chat/playwright-install-dialog";
import { RightSidePanel } from "@/components/chat/right-side-panel";
import { ShareConversationDialog } from "@/components/chat/share-conversation-dialog";
import { StreamTimeoutWarning } from "@/components/chat/stream-timeout-warning";
import type { ChatApiKeyFormValues } from "@/components/chat-api-key-form";
import { CreateChatApiKeyDialog } from "@/components/create-chat-api-key-dialog";
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
import { useHasPermissions } from "@/lib/auth.query";
import { useRecentlyGeneratedTitles } from "@/lib/chat.hook";
import {
  fetchConversationEnabledTools,
  useConversation,
  useCreateConversation,
  useHasPlaywrightMcpTools,
  useStopChatStream,
  useUpdateConversation,
  useUpdateConversationEnabledTools,
} from "@/lib/chat.query";
import { useChatAgentState } from "@/lib/chat-agent-state.hook";
import { useChatModels, useModelsByProvider } from "@/lib/chat-models.query";
import {
  type SupportedProvider,
  useChatApiKeys,
} from "@/lib/chat-settings.query";
import { useConversationShare } from "@/lib/chat-share.query";
import {
  conversationStorageKeys,
  getConversationDisplayTitle,
} from "@/lib/chat-utils";
import { useConfig } from "@/lib/config.query";
import { useDialogs } from "@/lib/dialog.hook";
import { useChatSession } from "@/lib/global-chat.context";
import { useOrganization } from "@/lib/organization.query";
import {
  applyPendingActions,
  clearPendingActions,
  getPendingActions,
} from "@/lib/pending-tool-state";
import { useTeams } from "@/lib/team.query";
import {
  clearModelOverride,
  getSavedAgent,
  getSavedModelOverride,
  type ModelSource,
  resolveInitialModel,
  resolveModelForAgent,
  saveAgent,
  saveModelOverride,
} from "@/lib/use-chat-preferences";
import { useIsMobile } from "@/lib/use-mobile.hook";
import { cn } from "@/lib/utils";
import ArchestraPromptInput from "./prompt-input";

const CONVERSATION_QUERY_PARAM = "conversation";

const BROWSER_OPEN_KEY = "archestra-chat-browser-open";

export default function ChatPage() {
  const queryClient = useQueryClient();
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

  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const { data: conversationShare } = useConversationShare(
    conversationId ?? undefined,
  );
  const isShared = !!conversationShare;

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
    llmProvider: ["read"],
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

  // State for browser panel - initialize from localStorage
  const [isBrowserPanelOpen, setIsBrowserPanelOpen] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(BROWSER_OPEN_KEY) === "true";
    }
    return false;
  });

  const hasChatAccess = canReadAgent !== false && canReadLlmProvider !== false;

  // Fetch internal agents for dialog editing
  const { data: internalAgents = [], isPending: isLoadingAgents } =
    useInternalAgents({ enabled: hasChatAccess });
  const { data: defaultAgentId } = useDefaultAgentId();

  // Fetch profiles and models for initial chat (no conversation)
  const { modelsByProvider, isPending: isModelsLoading } =
    useModelsByProvider();
  const { data: chatApiKeys = [], isLoading: isLoadingApiKeys } =
    useChatApiKeys({ enabled: hasChatAccess });
  const { data: organization, isPending: isOrgLoading } = useOrganization();

  // State for initial chat (when no conversation exists yet)
  const [initialAgentId, setInitialAgentId] = useState<string | null>(null);
  const [initialModel, setInitialModel] = useState<string>("");
  const [initialApiKeyId, setInitialApiKeyId] = useState<string | null>(null);
  const [initialModelSource, setInitialModelSource] =
    useState<ModelSource | null>(null);
  // Track which agentId URL param has been consumed (so we don't re-apply the same one after user clears selection,
  // but do apply a new one when navigating from a different agent page)
  const urlParamsConsumedRef = useRef<string | null>(null);

  // Resolve which agent to use on page load (URL param > localStorage > first available).
  // Stores the resolved agent in a ref so the model init effect can read it synchronously.
  const resolvedAgentRef = useRef<(typeof internalAgents)[number] | null>(null);

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
        setInitialAgentId(urlAgentId);
        resolvedAgentRef.current = matchingAgent;
        urlParamsConsumedRef.current = urlAgentId;
        return;
      }
    }

    // Priority: org default > localStorage > member default > first available
    // Org default always wins when set (admin-configured for the whole org).
    // localStorage only overrides when no org default is configured.
    // Also skip if a URL param was consumed but state hasn't flushed yet.
    if (!initialAgentId && !urlParamsConsumedRef.current) {
      // Try org's default agent first (admin-configured, takes precedence)
      if (organization?.defaultAgentId) {
        const orgDefaultAgent = internalAgents.find(
          (a) => a.id === organization.defaultAgentId,
        );
        if (orgDefaultAgent) {
          setInitialAgentId(organization.defaultAgentId);
          saveAgent(organization.defaultAgentId);
          resolvedAgentRef.current = orgDefaultAgent;
          return;
        }
      }
      // Try localStorage (user's previous selection, only when no org default)
      const savedAgentId = getSavedAgent();
      const savedAgent = internalAgents.find((a) => a.id === savedAgentId);
      if (savedAgent) {
        setInitialAgentId(savedAgentId);
        resolvedAgentRef.current = savedAgent;
        return;
      }
      // Try member's default agent
      if (defaultAgentId) {
        const defaultAgent = internalAgents.find(
          (a) => a.id === defaultAgentId,
        );
        if (defaultAgent) {
          setInitialAgentId(defaultAgentId);
          saveAgent(defaultAgentId);
          resolvedAgentRef.current = defaultAgent;
          return;
        }
      }
      setInitialAgentId(internalAgents[0].id);
      saveAgent(internalAgents[0].id);
      resolvedAgentRef.current = internalAgents[0];
    }
  }, [
    initialAgentId,
    searchParams,
    internalAgents,
    defaultAgentId,
    organization?.defaultAgentId,
    isOrgLoading,
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

    const agent = resolvedAgentRef.current;

    const resolved = resolveInitialModel({
      modelsByProvider,
      agent: agent ?? null,
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
    setInitialModelSource(
      resolved.source === "fallback" ? null : resolved.source,
    );
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
      const providerModels = modelsByProvider[newProvider];
      if (providerModels && providerModels.length > 0) {
        const bestModel =
          providerModels.find((m) => m.isBest) ?? providerModels[0];
        setInitialModel(bestModel.id);
        setInitialModelSource("user");
        saveModelOverride(bestModel.id);
      }
    },
    [modelsByProvider],
  );

  // Reset model override: clear localStorage and re-resolve from agent/org defaults
  const handleResetModelOverride = useCallback(() => {
    clearModelOverride();
    modelInitializedRef.current = false;

    const agent = resolvedAgentRef.current;
    const resolved = resolveInitialModel({
      modelsByProvider,
      agent: agent ?? null,
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
      setInitialModelSource(
        resolved.source === "fallback" ? null : resolved.source,
      );
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

  const chatSession = useChatSession(conversationId);

  const { isLoading: isLoadingFeatures } = useConfig();
  const { data: chatModels = [] } = useChatModels();
  // Check if user has any API keys (including system keys for keyless providers
  // like Vertex AI Gemini, vLLM, or Ollama which don't require secrets)
  const hasAnyApiKey = chatApiKeys.length > 0;
  const isLoadingApiKeyCheck = isLoadingApiKeys || isLoadingFeatures;

  // Sync conversation ID with URL and reset initial state when navigating to base /chat
  // Use a ref for the comparison so the effect only fires when the URL changes,
  // not when conversationId is set programmatically by selectConversation().
  // Without this, router.push() + setConversationId() creates a race: the effect
  // re-runs before the URL catches up and resets conversationId back to undefined.
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  useEffect(() => {
    // Normalize null to undefined for consistent comparison
    const conversationParam =
      searchParams.get(CONVERSATION_QUERY_PARAM) ?? undefined;
    if (conversationParam !== conversationIdRef.current) {
      setConversationId(conversationParam);

      // Reset initial state when navigating to /chat without a conversation
      // This ensures a fresh state when user clicks "New chat" or navigates back
      if (!conversationParam) {
        // Reset initial state to trigger re-selection from useEffects
        setInitialAgentId(null);
        setInitialModel("");
        setInitialModelSource(null);
        modelInitializedRef.current = false;
      }

      // Focus textarea after navigation (e.g., from search dialog)
      // Use requestAnimationFrame to ensure DOM is ready
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  }, [searchParams]);

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

      const providerModels = modelsByProvider[newProvider];
      if (providerModels && providerModels.length > 0) {
        const bestModel =
          providerModels.find((m) => m.isBest) ?? providerModels[0];
        updateConversationMutateRef.current({
          id: conversation.id,
          chatApiKeyId: apiKeyId,
          selectedModel: bestModel.id,
          selectedProvider: newProvider,
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
              llmModel?: string;
              llmApiKeyId?: string;
            })
          | undefined)
      : null;

    const resolved = resolveInitialModel({
      modelsByProvider,
      agent: agent ?? null,
      chatApiKeys,
      organization: organization
        ? {
            defaultLlmModel: organization.defaultLlmModel,
            defaultLlmApiKeyId: organization.defaultLlmApiKeyId,
          }
        : null,
    });

    if (resolved) {
      updateConversationMutateRef.current({
        id: conversation.id,
        selectedModel: resolved.modelId,
        selectedProvider:
          chatModels.find((m) => m.id === resolved.modelId)?.provider ??
          undefined,
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

  // Extract chat session properties (or use defaults if session not ready)
  const messages = chatSession?.messages ?? [];
  const sendMessage = chatSession?.sendMessage;
  const status = chatSession?.status ?? "ready";
  const setMessages = chatSession?.setMessages;
  const stop = chatSession?.stop;
  const error = chatSession?.error;
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

  // Find the specific internal agent for this conversation (if any)
  const _conversationInternalAgent = conversationAgentId
    ? internalAgents.find((a) => a.id === conversationAgentId)
    : undefined;

  // Get current agent info
  const currentProfileId = conversationAgentId;
  const browserToolsAgentId = conversationId
    ? (conversationAgentId ?? promptAgentId ?? undefined)
    : (initialAgentId ?? undefined);

  const playwrightSetupAgentId = conversationId
    ? (conversationAgentId ?? undefined)
    : (initialAgentId ?? undefined);

  const { hasPlaywrightMcpTools, isLoading: isLoadingBrowserTools } =
    useHasPlaywrightMcpTools(browserToolsAgentId, conversationId);
  // Show while loading so it doesn't flash hidden for members whose agent already has playwright
  // tools. Once loading is done, hides only if the user lacks permission AND agent has no tools.
  const showBrowserButton =
    canUpdateAgent ||
    hasPlaywrightMcpTools ||
    (!!conversationId && isLoadingConversation) ||
    (!!browserToolsAgentId && isLoadingBrowserTools);

  const {
    isLoading: isPlaywrightCheckLoading,
    isRequired: isPlaywrightSetupRequired,
  } = usePlaywrightSetupRequired(playwrightSetupAgentId, conversationId, {
    enabled: hasChatAccess && canUpdateAgent !== false,
  });
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
  const handleCreateConversationWithUrl = useCallback(
    (url: string) => {
      if (!initialAgentId || createConversationMutation.isPending) {
        return;
      }

      // Store the URL to navigate to after conversation is created
      setPendingBrowserUrl(url);

      // Find the provider for the initial model
      const modelInfo = chatModels.find((m) => m.id === initialModel);
      const selectedProvider = modelInfo?.provider;

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
      saveAgent(agentId);

      // Resolve model/key for the new agent using the same priority chain
      const selectedAgent = internalAgents.find((a) => a.id === agentId);
      if (selectedAgent) {
        resolvedAgentRef.current = selectedAgent;

        const resolved = resolveModelForAgent({
          agent: selectedAgent,
          context: {
            modelsByProvider,
            chatApiKeys,
            organization: organization
              ? {
                  defaultLlmModel: organization.defaultLlmModel,
                  defaultLlmApiKeyId: organization.defaultLlmApiKeyId,
                }
              : null,
          },
        });

        if (resolved) {
          setInitialModel(resolved.modelId);
          setInitialApiKeyId(resolved.apiKeyId);
          setInitialModelSource(
            resolved.source === "fallback" ? null : resolved.source,
          );
        }
      }
    },
    [internalAgents, modelsByProvider, chatApiKeys, organization],
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
      const selectedProvider = modelInfo?.provider;

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
      queryClient,
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

    // Find the provider for the initial model
    const modelInfo = chatModels.find((m) => m.id === initialModel);
    const selectedProvider = modelInfo?.provider;

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

  // Check if the conversation's agent was deleted
  const isAgentDeleted = conversationId && conversation && !conversation.agent;

  // If user lacks permission to read agents or LLM providers, show access denied
  // Must check before loading state since disabled queries stay in pending state
  if (canReadAgent === false || canReadLlmProvider === false) {
    const missingPermissions: string[] = [];
    if (canReadAgent === false) missingPermissions.push("agent:read");
    if (canReadLlmProvider === false)
      missingPermissions.push("llmProvider:read");
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
          <div className="flex flex-col items-center gap-1">
            {missingPermissions.map((p) => (
              <code
                key={p}
                className="rounded bg-muted px-2 py-1 text-sm font-mono"
              >
                {p}
              </code>
            ))}
          </div>
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
                {conversationId && (
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
                {conversationId && <div className="w-px h-4 bg-border" />}
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
                    {conversationId && (
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
                  onToolApprovalResponse={
                    addToolApprovalResponse
                      ? ({ id, approved, reason }) => {
                          addToolApprovalResponse({ id, approved, reason });
                        }
                      : undefined
                  }
                />
              </div>

              {isAgentDeleted ? (
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
            activeAgentId && (
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
                {organization?.chatLinks &&
                  organization.chatLinks.length > 0 && (
                    <div className="absolute top-4 right-4 z-10 flex flex-wrap justify-end gap-2 max-w-[min(100%,36rem)]">
                      {organization.chatLinks.map((link) => (
                        <ChatLinkButton
                          key={`${link.label}-${link.url}`}
                          url={link.url}
                          label={link.label}
                        />
                      ))}
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
                      agentId={activeAgentId}
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

      {conversationId && (
        <ShareConversationDialog
          conversationId={conversationId}
          open={isShareDialogOpen}
          onOpenChange={setIsShareDialogOpen}
        />
      )}
    </div>
  );
}

// =========================================================================
// No API Key Setup — shown when user has no API keys configured
// =========================================================================

const DEFAULT_FORM_VALUES: ChatApiKeyFormValues = {
  name: "",
  provider: "anthropic",
  apiKey: null,
  baseUrl: null,
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
        <Button onClick={() => setIsDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add API Key
        </Button>
      </div>
      <CreateChatApiKeyDialog
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
