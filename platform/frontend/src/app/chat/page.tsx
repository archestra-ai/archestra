"use client";

import type { UIMessage } from "@ai-sdk/react";
import type { ChatSkillMetadata } from "@archestra/shared";
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
import { CreateProjectFromChatDialog } from "@/app/_parts/create-project-from-chat-dialog";
import { scheduledRunContext } from "@/app/_parts/scheduled-run-sidebar.utils";
import { CustomServerRequestDialog } from "@/app/mcp/registry/_parts/custom-server-request-dialog";
import { getScheduledRunChatState } from "@/app/scheduled-tasks/schedule-trigger.utils";
import { AgentDialog } from "@/components/agent-dialog";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { Suggestion } from "@/components/ai-elements/suggestion";
import { ApiKeyLoadError } from "@/components/api-key-load-error";
import { AppLogo } from "@/components/app-logo";
import { ButtonWithTooltip } from "@/components/button-with-tooltip";
import { AppsProvider } from "@/components/chat/apps-context";
import { BrowserPanel } from "@/components/chat/browser-panel";
import { ChatLinkButton } from "@/components/chat/chat-help-link";
import { ChatMessages } from "@/components/chat/chat-messages";
import { collectBrowserToolCallIds } from "@/components/chat/chat-messages.utils";
import { ConversationFilesPanel } from "@/components/chat/conversation-files-panel";
import { ConversationHeader } from "@/components/chat/conversation-header";
import { InitialAgentSelector } from "@/components/chat/initial-agent-selector";
import { OnboardingWizardButton } from "@/components/chat/onboarding-wizard-button";
import {
  PlaywrightInstallDialog,
  usePlaywrightSetupRequired,
} from "@/components/chat/playwright-install-dialog";
import {
  type RightPanelTab,
  RightSidePanel,
} from "@/components/chat/right-side-panel";
import { ShareConversationDialog } from "@/components/chat/share-conversation-dialog";
import { StreamTimeoutWarning } from "@/components/chat/stream-timeout-warning";
import { useChatApps } from "@/components/chat/use-chat-apps";
import { DefaultModelOnboardingStep } from "@/components/default-model-onboarding";
import { LoadingSpinner } from "@/components/loading";
import MessageThread, {
  type PartialUIMessage,
} from "@/components/message-thread";
import { NoApiKeySetup } from "@/components/no-api-key-setup";
import { ScheduledRunInProgress } from "@/components/scheduled-tasks/scheduled-run-in-progress";
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
import {
  clearOAuthPendingChatResume,
  getOAuthPendingChatResume,
} from "@/lib/auth/oauth-session";
import {
  clearSsoSignInRedirectPath,
  getSsoSignInRedirectPath,
} from "@/lib/auth/sso-sign-in-attempt";
import {
  clearAllAppDiagnostics,
  drainAppDiagnostics,
} from "@/lib/chat/app-diagnostics-store";
import {
  fetchConversationEnabledTools,
  invalidateConversationFileQueries,
  useCompactConversation,
  useConversation,
  useConversationFiles,
  useCreateConversation,
  useHasPlaywrightMcpTools,
  useKeepViewedConversationRead,
  useMemberDefaultModel,
  useStopChatStream,
  useUpdateConversation,
  useUpdateConversationEnabledTools,
  useUpdateMemberDefaultModel,
} from "@/lib/chat/chat.query";
import { useChatAgentState } from "@/lib/chat/chat-agent-state.hook";
import {
  useConversationShare,
  useForkConversation,
  useForkSharedConversation,
} from "@/lib/chat/chat-share.query";
import {
  conversationStorageKeys,
  getConversationDisplayTitle,
  getManualCompactionSkippedMessage,
  mergePersistedMessageMetadata,
} from "@/lib/chat/chat-utils";
import { downloadConversationMarkdown } from "@/lib/chat/export-markdown";
import { useChatSession, useGlobalChat } from "@/lib/chat/global-chat.context";
import {
  drainPendingChatHandoffFiles,
  hasPendingChatHandoffFiles,
} from "@/lib/chat/pending-chat-handoff-files";
import { takePendingProjectChatHandoff } from "@/lib/chat/pending-project-chat-handoff";
import {
  applyPendingActions,
  clearPendingActions,
  getPendingActions,
} from "@/lib/chat/pending-tool-state";
import {
  agentRequiresPerUserConnect,
  deriveModelSource,
} from "@/lib/chat/use-chat-preferences";
import { useInitialChatModelState } from "@/lib/chat/use-initial-chat-model-state.hook";
import { useConfig } from "@/lib/config/config.query";
import {
  type ConnectivityState,
  useConnectivity,
} from "@/lib/config/connectivity";
import { useDialogs } from "@/lib/hooks/use-dialog";
import { useIsMobile } from "@/lib/hooks/use-mobile";
import { useLlmModels, useLlmModelsByProvider } from "@/lib/llm-models.query";
import {
  type SupportedProvider,
  useLlmProviderApiKeys,
} from "@/lib/llm-provider-api-keys.query";
import { useOrganization } from "@/lib/organization.query";
import { canCreateProjectFromChat } from "@/lib/projects/can-create-project-from-chat";
import { useProjectFiles } from "@/lib/projects/projects.query";
import { useScheduleTriggerRun } from "@/lib/schedule-trigger.query";
import { useSkill, useSkillsPaginated } from "@/lib/skills/skill.query";
import { useTeams } from "@/lib/teams/team.query";
import { cn } from "@/lib/utils";
import {
  buildCreateConversationInput,
  isAutoSendHandoffInProgress,
  resolveChatModelState,
  resolvePreferredModelForProvider,
} from "./chat-initial-state";
import ArchestraPromptInput, {
  type ArchestraPromptInputProps,
  type ChatSubmitOptions,
} from "./prompt-input";
import { resolveSharedConversationForkState } from "./shared-conversation-fork";
import { buildSkillCommands, resolveUrlSkillAction } from "./skill-commands";

const RIGHT_PANEL_TABS: readonly RightPanelTab[] = [
  "runs",
  "files",
  "browser",
  "apps",
];

function parseRightPanelTab(value: string | null): RightPanelTab | null {
  return RIGHT_PANEL_TABS.includes(value as RightPanelTab)
    ? (value as RightPanelTab)
    : null;
}

// Copy for the chat-send guard, picked per failure mode so the message matches
// reality (browser offline vs backend down, which is not "you're offline").
function offlineSubmitMessage(
  kind: Exclude<ConnectivityState["kind"], "online">,
): string {
  switch (kind) {
    case "browser-offline":
      return "You're offline — your message wasn't sent. Try again once you're back online.";
    case "backend-unreachable":
      return "Can't reach the server — your message wasn't sent. Try again in a moment.";
  }
}

export function ChatPageContent({
  routeConversationId,
}: {
  routeConversationId?: string;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [conversationId, setConversationId] = useState<string | undefined>(
    routeConversationId,
  );

  useEffect(() => {
    if (routeConversationId) {
      clearSsoSignInRedirectPath();
      return;
    }

    const redirectPath = getSsoSignInRedirectPath();
    if (!redirectPath || redirectPath === "/chat") {
      clearSsoSignInRedirectPath();
      return;
    }

    clearSsoSignInRedirectPath();
    router.replace(redirectPath);
  }, [routeConversationId, router]);

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
  // Skill invoked via slash command on the first message of a new chat,
  // held until the conversation exists and the message can be sent.
  const pendingSkillRef = useRef<ChatSkillMetadata | undefined>(undefined);
  // Sandbox-command marker (`!` prefix) on the first message of a new chat,
  // held the same way so the deferred send stamps metadata.sandboxCommand.
  const pendingSandboxCommandRef = useRef<true | undefined>(undefined);
  // Composer prefill from a `?skillId=` deep link; handed to the composer
  // once and cleared via onPrefillApplied.
  const [composerPrefill, setComposerPrefill] = useState<string | null>(null);
  const urlSkillProcessedRef = useRef(false);
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
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState(false);
  const [isForkDialogOpen, setIsForkDialogOpen] = useState(false);
  const [forkAgentId, setForkAgentId] = useState<string | null>(null);
  const [manualCompactionFeedback, setManualCompactionFeedback] = useState<{
    status: "pending" | "success" | "skipped" | "failed";
    message: string;
  } | null>(null);
  const forkConversationMutation = useForkConversation();
  const forkSharedConversationMutation = useForkSharedConversation();
  const { data: session } = useSession();

  // Dialog management for MCP installation
  const { isDialogOpened, openDialog, closeDialog } = useDialogs<
    "custom-request" | "edit-agent"
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
  const { data: canCreateProjectPerm } = useHasPermissions({
    project: ["create"],
  });
  const { data: teams } = useTeams({ enabled: !!canReadTeams });

  // Non-admin users with no teams cannot create agents
  const cannotCreateDueToNoTeams =
    !isAgentAdmin && (!teams || teams.length === 0);

  const _isMobile = useIsMobile();

  // State for browser panel. Restored per-conversation by the conversation-load
  // effect below (a fresh /chat with no conversation has no saved state).
  const [isBrowserPanelOpen, setIsBrowserPanelOpen] = useState(false);

  // Tracks which tab the right-side panel last showed; restored when the panel
  // is re-opened via the header toggle.
  const [activeRightTab, setActiveRightTab] = useState<RightPanelTab>("files");

  // Independent of artifact/browser open state — toggled when the Apps tab is selected.
  const [isAppsTabOpen, setIsAppsTabOpen] = useState(false);
  // The Runs tab, shown only for scheduled-run chats (a `?scheduleTriggerId=` URL).
  const [isRunsTabOpen, setIsRunsTabOpen] = useState(false);
  // Scheduled-run context from the chat URL the runs view links with; non-null
  // enables the right-side Runs tab.
  const scheduledRun = scheduledRunContext(searchParams);
  const scheduledRunTriggerId = scheduledRun?.triggerId ?? null;

  // Poll the pinned scheduled run while it's still running. A project-scoped
  // run's transcript is only persisted at completion, so the chat shows an
  // in-progress placeholder (and hides the composer) until then, and reveals the
  // transcript the moment the run finishes. Polling stops once the run is
  // terminal so a completed run's chat isn't polled forever.
  const { data: scheduledRunData } = useScheduleTriggerRun(
    scheduledRunTriggerId,
    scheduledRun?.runId ?? null,
    {
      refetchInterval: (query) =>
        query.state.data?.status === "running" ? 3_000 : false,
    },
  );
  const { isRunInProgress: isScheduledRunInProgress } =
    getScheduledRunChatState({
      context: scheduledRun,
      runStatus: scheduledRunData?.status,
    });
  // When the run flips from running to done, refetch the conversation so its
  // just-persisted transcript (or error card) loads without a manual refresh.
  const prevScheduledRunStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previous = prevScheduledRunStatusRef.current;
    const current = scheduledRunData?.status;
    prevScheduledRunStatusRef.current = current;
    if (
      previous === "running" &&
      current != null &&
      current !== "running" &&
      conversationId
    ) {
      queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });
    }
  }, [scheduledRunData?.status, conversationId, queryClient]);

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
  const {
    data: chatApiKeys = [],
    isLoading: isLoadingApiKeys,
    isLoadingError: isApiKeysLoadError,
    refetch: refetchApiKeys,
  } = useLlmProviderApiKeys({
    enabled: hasChatAccess && canUseProviderSettings,
    toastOnError: false,
  });
  const { data: organization, isPending: isOrgLoading } = useOrganization();
  // The user's saved default (model, key) pair — top of the resolution chain
  // for a new chat ("member" level).
  const { data: memberDefault } = useMemberDefaultModel();

  // Shared new-chat initialization (agent/model/key resolution + persistence).
  const {
    agentId: initialAgentId,
    modelId: initialModel,
    apiKeyId: initialApiKeyId,
    provider: initialProvider,
    modelSource: initialModelSource,
    setApiKeyId: setInitialApiKeyId,
    onAgentChange: handleInitialAgentChange,
    onModelChange: handleInitialModelChange,
    onProviderChange: handleInitialProviderChange,
    onResetModelOverride: handleResetModelOverride,
  } = useInitialChatModelState({
    agents: internalAgents,
    organization: organization ?? null,
    defaultAgentId,
    modelsByProvider,
    chatApiKeys,
    memberDefault: memberDefault ?? null,
    urlAgentId: searchParams.get("agentId"),
    canUseSavedAgent: canSeeAgentPicker === true,
    isPermissionResolving: isAgentPickerPermissionLoading,
    isOrgLoading,
    routeConversationId,
  });

  // Persist the user's (model, key) pick as their member default for the
  // existing-conversation handlers below (the initial handlers persist via the
  // hook). No-ops on an incomplete pair.
  const updateMemberDefaultModelMutation = useUpdateMemberDefaultModel();
  const updateMemberDefaultModelMutateRef = useRef(
    updateMemberDefaultModelMutation.mutate,
  );
  updateMemberDefaultModelMutateRef.current =
    updateMemberDefaultModelMutation.mutate;
  const persistMemberDefaultModel = useCallback(
    (modelId: string | null, apiKeyId: string | null) => {
      if (!modelId || !apiKeyId) return;
      updateMemberDefaultModelMutateRef.current({
        modelId,
        chatApiKeyId: apiKeyId,
      });
    },
    [],
  );

  const { isLoading: isLoadingFeatures } = useConfig();
  const { data: chatModels = [] } = useLlmModels();
  // Check if user has any API keys (including system keys for keyless providers
  // like Vertex AI Gemini, vLLM, or Ollama which don't require secrets)
  const hasAnyApiKey = chatApiKeys.length > 0;
  const isLoadingApiKeyCheck = isLoadingApiKeys || isLoadingFeatures;

  useEffect(() => {
    setConversationId(routeConversationId);

    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [routeConversationId]);

  // Get user_prompt from URL for auto-sending
  const initialUserPrompt = useMemo(() => {
    return searchParams.get("user_prompt") || undefined;
  }, [searchParams]);

  // A chat whose conversation was created up front (by the project composer, or
  // by the apps page for an external app whose tool needs inputs) stashes its
  // opening prompt and navigates straight here. Drain that prompt (and any
  // attachments the composer stashed) into the pending-initial-message refs so
  // the shared send effect delivers them as the conversation's first message.
  // Gated on the conversation id, so an ordinary /chat/<id> open never
  // consumes it.
  useEffect(() => {
    if (!conversationId) return;
    const handoff = takePendingProjectChatHandoff(conversationId);
    if (!handoff) return;
    pendingPromptRef.current = handoff.prompt || undefined;
    pendingFilesRef.current = drainPendingChatHandoffFiles();
  }, [conversationId]);

  // Resolve a `?skillId=` deep link (from /chat/new) into a composer prefill
  // with the skill's slash command. The param is transient, same posture as
  // user_prompt: stripped once processed so a refresh or remount cannot
  // re-apply it. A combined skillId + user_prompt link is unsupported (no UI
  // produces it): the auto-send would orphan the prefill, so the skill is
  // skipped and only the prompt is sent.
  const urlSkillId = searchParams.get("skillId");
  const urlSkillWanted = !!urlSkillId && !initialUserPrompt;
  const urlSkillQuery = useSkill(urlSkillWanted ? urlSkillId : null);
  const skillToolsEnabled = organization?.skillToolsEnabled ?? false;
  // Same query the composer's slash-command table is built from (identical
  // input → shared TanStack cache entry). The prefill token must come from
  // that table, not be re-derived from the skill name, so slug collisions
  // resolve to the right skill.
  const urlSkillCommandsQuery = useSkillsPaginated(
    { limit: 100 },
    { enabled: urlSkillWanted && skillToolsEnabled },
  );
  useEffect(() => {
    if (urlSkillProcessedRef.current || !urlSkillId) return;
    if (!urlSkillWanted) {
      urlSkillProcessedRef.current = true;
      clearSkillIdQueryParam({ pathname, router, searchParams });
      return;
    }
    // Wait for the org flag, the skill fetch, and the command table. useSkill
    // treats a 404 as success with null data (allowNotFound), and a non-404
    // lands the query in its error state — both settle this effect. An errored
    // list query settles with no commands, which resolves to "unavailable".
    if (isOrgLoading) return;
    if (!urlSkillQuery.isSuccess && !urlSkillQuery.isError) return;
    if (
      skillToolsEnabled &&
      !urlSkillCommandsQuery.isSuccess &&
      !urlSkillCommandsQuery.isError
    ) {
      return;
    }

    urlSkillProcessedRef.current = true;
    clearSkillIdQueryParam({ pathname, router, searchParams });

    const action = resolveUrlSkillAction({
      skill: urlSkillQuery.data ?? null,
      isError: urlSkillQuery.isError,
      skillCommands: urlSkillCommandsQuery.data?.data
        ? buildSkillCommands(urlSkillCommandsQuery.data.data)
        : [],
    });
    if (action.kind === "prefill") {
      setComposerPrefill(action.text);
    } else if (action.reason === "unavailable") {
      toast.error("This skill is not available in chat");
    } else {
      toast.error("Skill not found");
    }
  }, [
    urlSkillId,
    urlSkillWanted,
    urlSkillQuery.isSuccess,
    urlSkillQuery.isError,
    urlSkillQuery.data,
    urlSkillCommandsQuery.isSuccess,
    urlSkillCommandsQuery.isError,
    urlSkillCommandsQuery.data,
    isOrgLoading,
    skillToolsEnabled,
    pathname,
    router,
    searchParams,
  ]);

  const handleComposerPrefillApplied = useCallback(() => {
    setComposerPrefill(null);
  }, []);

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

  // App render diagnostics are conversation-scoped: drop any leftovers when
  // switching conversations so they never attach to an unrelated send.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately re-runs on conversation switch
  useEffect(() => {
    clearAllAppDiagnostics();
  }, [conversationId]);

  // Fetch conversation with messages
  const { data: conversation, isLoading: isLoadingConversation } =
    useConversation(conversationId);
  const canManageShare =
    !!conversationId &&
    !!conversation &&
    conversation.userId === session?.user.id;
  useConversationShare(canManageShare ? conversationId : undefined);

  // Turning this chat into a project is owner-only (same as sharing) and
  // restricted to a user chat not already in a project.
  const canCreateProjectFromThisChat =
    canManageShare &&
    !!conversation &&
    canCreateProjectFromChat({
      hasCreatePermission: canCreateProjectPerm === true,
      conversation,
    });
  const isShared = !!conversation?.share;
  const isReadOnlyConversation =
    !!conversationId &&
    !!conversation &&
    conversation.userId !== session?.user.id;
  const persistedConversationMessages = useMemo(
    () => (conversation?.messages ?? []) as UIMessage[],
    [conversation?.messages],
  );
  const shouldEnableChatSession =
    !!conversationId &&
    !isReadOnlyConversation &&
    (!routeConversationId || !!conversation);
  const chatSession = useChatSession({
    conversationId: shouldEnableChatSession ? conversationId : undefined,
    initialMessages: persistedConversationMessages,
    enabled: shouldEnableChatSession,
  });
  const connectivity = useConnectivity();
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

  // Conversations whose title should play the typing animation (shared via chat context)
  const { animatingTitleIds: headerAnimatingTitles } = useGlobalChat();

  // Viewing a conversation marks it read (clears the sidebar new-messages dot).
  // Reads the viewed id from the URL internally.
  useKeepViewedConversationRead();

  // Restore the right-side panel (open state + selected tab) when a conversation
  // loads. Both are remembered per-conversation in localStorage.
  useEffect(() => {
    // If no conversation (new chat), close the panel.
    if (!conversationId) {
      setIsArtifactOpen(false);
      setIsBrowserPanelOpen(false);
      setIsAppsTabOpen(false);
      setIsRunsTabOpen(false);
      return;
    }

    if (isLoadingConversation) return;

    const keys = conversationStorageKeys(conversationId);
    const openState = localStorage.getItem(keys.rightPanelOpen);

    if (openState !== null) {
      // User has an explicit preference for this conversation. Default a
      // missing/invalid saved tab to "files" (the default tab).
      const tab =
        parseRightPanelTab(localStorage.getItem(keys.rightPanelTab)) ?? "files";
      const isOpen = openState === "true";
      setIsArtifactOpen(isOpen && tab === "files");
      setIsBrowserPanelOpen(isOpen && tab === "browser");
      setIsAppsTabOpen(isOpen && tab === "apps");
      setIsRunsTabOpen(isOpen && tab === "runs");
      setActiveRightTab(tab);
    } else if (conversation?.artifact) {
      // First time viewing this conversation with an artifact - auto-open Files.
      setIsArtifactOpen(true);
      setIsBrowserPanelOpen(false);
      setIsAppsTabOpen(false);
      setIsRunsTabOpen(false);
      setActiveRightTab("files");
      localStorage.setItem(keys.rightPanelOpen, "true");
      localStorage.setItem(keys.rightPanelTab, "files");
    } else {
      // No artifact or no stored preference - keep closed.
      setIsArtifactOpen(false);
      setIsBrowserPanelOpen(false);
      setIsAppsTabOpen(false);
      setIsRunsTabOpen(false);
    }
  }, [conversationId, conversation?.artifact, isLoadingConversation]);

  // Derive current provider from the selected model
  const currentProvider = useMemo((): SupportedProvider | undefined => {
    if (!conversation?.modelId) return undefined;
    const model = chatModels.find((m) => m.dbId === conversation.modelId);
    return model?.provider;
  }, [conversation?.modelId, chatModels]);

  // Model source — derived purely by comparing the selected model against the
  // agent's and org's configured defaults. No stored state, nothing to keep in sync.
  const conversationModelSource = useMemo(() => {
    const agent = internalAgents.find((a) => a.id === conversation?.agentId) as
      | (Record<string, unknown> & { modelId?: string | null })
      | undefined;
    return deriveModelSource({
      selectedModelId: conversation?.modelId,
      agentModelId: agent?.modelId,
      orgModelId: organization?.defaultModelId,
    });
  }, [
    conversation?.modelId,
    conversation?.agentId,
    internalAgents,
    organization?.defaultModelId,
  ]);

  // A shared agent can pin a per-user-credential model (e.g. GitHub Copilot).
  // When the viewer hasn't connected their own account that model is not in
  // their available list; keep it selected (no silent swap) so sending it
  // surfaces an inline connect prompt instead of substituting another provider.
  // Returns whether the per-user connect prompt applies and, if so, the agent's
  // resolved model name — so the read-only chip can show "gpt-4" instead of the
  // model's UUID (which the viewer can't resolve without access to the key).
  const initialPerUserConnect = useMemo(() => {
    const agent = internalAgents.find((a) => a.id === initialAgentId);
    return {
      needsConnect: agentRequiresPerUserConnect({
        agent,
        selectedModelId: initialModel,
        isModelAvailable: chatModels.some((m) => m.dbId === initialModel),
      }),
      modelName: agent?.resolvedLlmModelName ?? undefined,
    };
  }, [internalAgents, initialAgentId, initialModel, chatModels]);

  const conversationPerUserConnect = useMemo(() => {
    const agent = internalAgents.find((a) => a.id === conversation?.agentId);
    return {
      needsConnect: agentRequiresPerUserConnect({
        agent,
        selectedModelId: conversation?.modelId,
        isModelAvailable: chatModels.some(
          (m) => m.dbId === conversation?.modelId,
        ),
      }),
      modelName: agent?.resolvedLlmModelName ?? undefined,
    };
  }, [
    internalAgents,
    conversation?.agentId,
    conversation?.modelId,
    chatModels,
  ]);

  // Get selected model's context length for the context indicator
  const selectedModelContextLength = useMemo((): number | null => {
    const modelId = conversation?.modelId ?? initialModel;
    if (!modelId) return null;
    const model = chatModels.find((m) => m.dbId === modelId);
    return model?.capabilities?.contextLength ?? null;
  }, [conversation?.modelId, initialModel, chatModels]);

  // Get selected model's input modalities for file upload filtering
  const selectedModelInputModalities = useMemo(() => {
    const modelId = conversation?.modelId ?? initialModel;
    if (!modelId) return null;
    const model = chatModels.find((m) => m.dbId === modelId);
    return model?.capabilities?.inputModalities ?? null;
  }, [conversation?.modelId, initialModel, chatModels]);

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
  const chatApiKeysRef = useRef(chatApiKeys);
  chatApiKeysRef.current = chatApiKeys;
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  // Picking a model also pins the API key it runs through: a conversation
  // stores the (model, key) pair as a unit, so a model is never persisted
  // without its key. Keep the conversation's current key when it serves the
  // model's provider, otherwise use any key for that provider.
  const handleModelChange = useCallback(
    (modelId: string) => {
      const conv = conversationRef.current;
      if (!conv) return;
      const model = chatModelsRef.current.find((m) => m.dbId === modelId);
      const currentKey = chatApiKeysRef.current.find(
        (k) => k.id === conv.chatApiKeyId,
      );
      const chatApiKeyId =
        currentKey && currentKey.provider === model?.provider
          ? currentKey.id
          : (chatApiKeysRef.current.find((k) => k.provider === model?.provider)
              ?.id ?? null);
      updateConversationMutateRef.current({
        id: conv.id,
        modelId,
        chatApiKeyId,
      });
      persistMemberDefaultModel(modelId, chatApiKeyId);
    },
    [persistMemberDefaultModel],
  );

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
          modelId: preferredModel.modelId,
        });
        persistMemberDefaultModel(preferredModel.modelId, apiKeyId);
      } else {
        // No models for this provider yet, still update the key
        updateConversationMutateRef.current({
          id: conversation.id,
          chatApiKeyId: apiKeyId,
        });
      }
    },
    [conversation, modelsByProvider, persistMemberDefaultModel],
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

  // Reset an existing conversation to its agent/org default model.
  const handleConversationResetModelOverride = useCallback(() => {
    if (!conversation) return;

    const agent = conversation.agentId
      ? (internalAgents.find((a) => a.id === conversation.agentId) as
          | (Record<string, unknown> & {
              id: string;
              modelId?: string | null;
              llmApiKeyId?: string | null;
            })
          | undefined)
      : null;

    const resolved = resolveChatModelState({
      agent: agent ?? null,
      modelsByProvider,
      chatApiKeys,
      organization: organization
        ? {
            defaultModelId: organization.defaultModelId,
            defaultLlmApiKeyId: organization.defaultLlmApiKeyId,
          }
        : null,
      // Reset deliberately drops the user's personal override.
      memberDefault: null,
    });

    if (resolved) {
      updateConversationMutateRef.current({
        id: conversation.id,
        modelId: resolved.modelId,
        chatApiKeyId: resolved.apiKeyId,
      });
    }

    // Clear the saved member default too — resetting the chat override also
    // drops the user override it came from.
    updateMemberDefaultModelMutateRef.current({
      modelId: null,
      chatApiKeyId: null,
    });
  }, [
    conversation,
    internalAgents,
    modelsByProvider,
    chatApiKeys,
    organization,
  ]);

  // Create conversation mutation (requires agentId)
  const createConversationMutation = useCreateConversation();

  // Update enabled tools mutation (for applying pending actions)
  const updateEnabledToolsMutation = useUpdateConversationEnabledTools();

  // Stop chat stream mutation (signals backend to abort subagents)
  const stopChatStreamMutation = useStopChatStream();
  const compactConversationMutation = useCompactConversation();

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
      setActiveRightTab("files");
      // Save the preference for this conversation
      const keys = conversationStorageKeys(conversationId);
      localStorage.setItem(keys.rightPanelOpen, "true");
      localStorage.setItem(keys.rightPanelTab, "files");
    }

    // Update the ref for next comparison
    previousArtifactRef.current = conversation?.artifact;
  }, [conversation?.artifact, isArtifactOpen, conversationId]);

  // Auto-open the Files panel to the list when a generated file arrives and
  // there is no artifact (the artifact case is handled by the effects above,
  // which open straight to artifact.md).
  const { data: conversationFiles } = useConversationFiles(conversationId);
  const generatedCount = conversationFiles?.generated?.length ?? 0;
  const previousGeneratedCountRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (
      conversationId &&
      !conversation?.artifact &&
      previousGeneratedCountRef.current !== undefined &&
      generatedCount > previousGeneratedCountRef.current &&
      !isArtifactOpen
    ) {
      setActiveRightTab("files");
      setIsArtifactOpen(true);
      const keys = conversationStorageKeys(conversationId);
      localStorage.setItem(keys.rightPanelOpen, "true");
      localStorage.setItem(keys.rightPanelTab, "files");
    }
    previousGeneratedCountRef.current = generatedCount;
  }, [generatedCount, conversation?.artifact, isArtifactOpen, conversationId]);

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
  const mcpApps = useChatApps({
    messages,
    earlyToolUiStarts: chatSession?.earlyToolUiStarts ?? {},
    filterDeleted: true,
  });
  const sendMessage = chatSession?.sendMessage;
  const regenerateUserMessage = chatSession?.regenerateUserMessage;
  const status = chatSession?.status ?? "ready";
  const setMessages = chatSession?.setMessages;
  const stop = chatSession?.stop;

  // A scheduled run's transcript is persisted only when it completes, so a run
  // opened while still running seeds the live chat session empty. When the run
  // finishes, the completion effect refetches the conversation; hydrate the
  // (still-empty) session with the arrived transcript so the chat renders without
  // a manual refresh. Gated to the empty-session case, so it never clobbers an
  // ordinary conversation (seeded via initialMessages) or a live turn.
  useEffect(() => {
    if (!scheduledRunTriggerId || isScheduledRunInProgress || !setMessages) {
      return;
    }
    if (
      persistedConversationMessages.length > 0 &&
      chatSession?.messages?.length === 0
    ) {
      setMessages(persistedConversationMessages);
    }
  }, [
    scheduledRunTriggerId,
    isScheduledRunInProgress,
    persistedConversationMessages,
    chatSession?.messages?.length,
    setMessages,
  ]);

  // Re-send the most recent user message by regenerating its turn. Shared by the
  // provider-connect auto-rerun and the "Try again" affordance. Resolves to whether
  // a resend was actually issued (false while a turn is in flight or there's no user
  // message); awaiting regenerateUserMessage means it only resolves true once the
  // turn is genuinely being re-run, so callers can safely gate side effects (e.g.
  // clearing the persisted error) on the result.
  const resendLastUserMessage = useCallback(async (): Promise<boolean> => {
    if (status === "submitted" || status === "streaming") return false;
    if (!regenerateUserMessage) return false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== "user") continue;
      const partIndex = message.parts.findIndex((part) => part.type === "text");
      if (partIndex < 0) return false;
      const part = message.parts[partIndex];
      const text = "text" in part ? part.text : "";
      await regenerateUserMessage({ messageId: message.id, partIndex, text });
      return true;
    }
    return false;
  }, [messages, regenerateUserMessage, status]);

  // After the user connects a per-user provider (e.g. GitHub Copilot) via the
  // inline auth card, re-run their original prompt automatically. The connect
  // mutation already invalidated the model/key caches. Fire-and-forget: the
  // provider-auth card owns its own feedback.
  const handleProviderConnected = useCallback(() => {
    void resendLastUserMessage().catch((error) => {
      console.error("[Chat] Failed to re-run after provider connect", error);
    });
  }, [resendLastUserMessage]);

  // "Try again" on a retryable chat error: resend the last user turn. The
  // session's regenerateUserMessage clears the persisted error rows once the
  // resend is genuinely issued (so the card disappears without wiping the
  // error when the resend never starts) — same as the regenerate action on a
  // message. If the resend itself fails, the card stays so the user still sees
  // the error. Owner-editable chats only (read-only viewers render
  // MessageThread instead of this).
  const handleChatErrorRetry = useCallback(async () => {
    try {
      await resendLastUserMessage();
    } catch (error) {
      console.error("[Chat] Retry failed to resend the last message", error);
    }
  }, [resendLastUserMessage]);
  // Hide the error while the session is auto-recovering (retry scheduled or
  // reattaching to the still-running response) — flashing a "connection
  // error" card for a turn that restores itself a second later reads as
  // breakage. If recovery fails, the terminal error clears isRecovering and
  // surfaces here.
  const error =
    status === "submitted" ||
    status === "streaming" ||
    chatSession?.isRecovering
      ? undefined
      : chatSession?.error;
  const addToolResult = chatSession?.addToolResult;
  const addToolApprovalResponse = chatSession?.addToolApprovalResponse;
  const pendingCustomServerToolCall = chatSession?.pendingCustomServerToolCall;
  const optimisticToolCalls = chatSession?.optimisticToolCalls ?? [];
  const browserToolCallIds = useMemo(
    () =>
      collectBrowserToolCallIds({
        messages,
        optimisticToolCalls,
      }),
    [messages, optimisticToolCalls],
  );
  const setPendingCustomServerToolCall =
    chatSession?.setPendingCustomServerToolCall;
  const tokenUsage = chatSession?.tokenUsage;
  const contextTokensUsed = chatSession?.contextTokensUsed;
  const contextWindow = chatSession?.contextWindow ?? null;
  const contextCompaction = chatSession?.contextCompaction;
  const recordContextCompaction = chatSession?.recordContextCompaction;

  const syncPersistedMessageMetadata = useCallback(
    (persistedMessages: UIMessage[]) => {
      if (!chatSession?.messages || !setMessages) {
        return;
      }

      const mergedMessages = mergePersistedMessageMetadata({
        liveMessages: chatSession.messages,
        persistedMessages,
      });

      if (mergedMessages === chatSession.messages) {
        return;
      }

      setMessages(mergedMessages);
    },
    [chatSession?.messages, setMessages],
  );

  useEffect(() => {
    if (status !== "ready") {
      return;
    }

    syncPersistedMessageMetadata(persistedConversationMessages);
  }, [persistedConversationMessages, status, syncPersistedMessageMetadata]);

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
  const conversationToolsStateId = isReadOnlyConversation
    ? undefined
    : conversationId;
  const browserToolsAgentId = isReadOnlyConversation
    ? undefined
    : conversationId
      ? (conversationAgentId ?? promptAgentId ?? undefined)
      : (initialAgentId ?? undefined);

  const playwrightSetupAgentId = isReadOnlyConversation
    ? undefined
    : conversationId
      ? (conversationAgentId ?? undefined)
      : (initialAgentId ?? undefined);

  const { hasPlaywrightMcpTools, isLoading: isLoadingBrowserTools } =
    useHasPlaywrightMcpTools(browserToolsAgentId, conversationToolsStateId);
  // Show while loading so it doesn't flash hidden for members whose agent already has playwright
  // tools. Once loading is done, hides only if the user lacks permission AND agent has no tools.
  const showBrowserButton =
    !isReadOnlyConversation &&
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
        !isReadOnlyConversation && hasChatAccess && canUpdateAgent !== false,
    },
  );
  // Treat both loading and required as "visible" for disabling submit, hiding arrow, etc.
  // Only applies to users who can actually perform the installation.
  const isPlaywrightSetupVisible =
    !!canUpdateAgent && (isPlaywrightSetupRequired || isPlaywrightCheckLoading);

  // Stream usage and compaction results both update this live context estimate.
  const tokensUsed = contextTokensUsed ?? tokenUsage?.totalTokens;
  const isContextCompacting =
    !!contextCompaction?.isCompacting || compactConversationMutation.isPending;

  const handleCompactConversation = useCallback(async () => {
    if (!conversationId || isReadOnlyConversation) {
      return;
    }

    setManualCompactionFeedback({
      status: "pending",
      message: "Compacting conversation context...",
    });

    const result = await compactConversationMutation.mutateAsync({
      id: conversationId,
    });
    if (!result) {
      setManualCompactionFeedback({
        status: "failed",
        message: "Context compaction failed.",
      });
      return;
    }

    syncPersistedMessageMetadata(
      (result.conversation.messages ?? []) as UIMessage[],
    );

    switch (result.status) {
      case "created": {
        if (result.compaction) {
          recordContextCompaction?.({
            compactionId: result.compaction.id,
            originalTokenEstimate: result.compaction.originalTokenEstimate,
            compactedTokenEstimate: result.compaction.compactedTokenEstimate,
            trigger: "manual",
          });
        }

        setManualCompactionFeedback(null);
        return;
      }
      case "existing": {
        if (result.compaction) {
          recordContextCompaction?.({
            compactionId: result.compaction.id,
            originalTokenEstimate: result.compaction.originalTokenEstimate,
            compactedTokenEstimate: result.compaction.compactedTokenEstimate,
            trigger: "manual",
          });
        }

        setManualCompactionFeedback({
          status: "skipped",
          message: getManualCompactionSkippedMessage(
            result.reason,
            result.status,
          ),
        });
        return;
      }
      case "skipped": {
        setManualCompactionFeedback({
          status: "skipped",
          message: getManualCompactionSkippedMessage(
            result.reason,
            result.status,
          ),
        });
        return;
      }
      case "failed": {
        setManualCompactionFeedback({
          status: "failed",
          message: "Context compaction failed.",
        });
        return;
      }
      default: {
        // compile-time guard: a new status must be handled explicitly above
        result.status satisfies never;
        setManualCompactionFeedback({
          status: "failed",
          message: "Context compaction failed.",
        });
        return;
      }
    }
  }, [
    compactConversationMutation,
    conversationId,
    isReadOnlyConversation,
    recordContextCompaction,
    syncPersistedMessageMetadata,
  ]);

  useEffect(() => {
    if (
      !manualCompactionFeedback ||
      manualCompactionFeedback.status === "pending"
    ) {
      return;
    }

    const timeout = setTimeout(() => {
      setManualCompactionFeedback(null);
    }, 8000);

    return () => clearTimeout(timeout);
  }, [manualCompactionFeedback]);

  useEffect(() => {
    if (
      !pendingCustomServerToolCall ||
      !addToolResult ||
      !setPendingCustomServerToolCall
    ) {
      return;
    }

    // Users who can create catalog items get the Add MCP Server page (in a
    // new tab so the conversation stays put); others get the request dialog.
    if (canCreateCatalog) {
      window.open("/mcp/registry/new", "_blank");
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
              ? "Opening the Add MCP Server to Private Registry page."
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

    const hasPendingInitialMessage =
      !!pendingPromptRef.current ||
      pendingFilesRef.current.length > 0 ||
      !!pendingSkillRef.current;
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
    const skillToSend = pendingSkillRef.current;
    const sandboxCommandToSend = pendingSandboxCommandRef.current;
    pendingPromptRef.current = undefined;
    pendingFilesRef.current = [];
    pendingSkillRef.current = undefined;
    pendingSandboxCommandRef.current = undefined;

    const parts: ChatMessagePart[] = [];

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

    const initialAppDiagnostics = drainAppDiagnostics();
    sendMessage({
      role: "user",
      parts: ensureNonEmptyParts(parts),
      metadata: {
        createdAt: new Date().toISOString(),
        ...(skillToSend ? { skill: skillToSend } : {}),
        ...(sandboxCommandToSend ? { sandboxCommand: true as const } : {}),
        ...(initialAppDiagnostics.length > 0
          ? { appDiagnostics: initialAppDiagnostics }
          : {}),
      },
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
      invalidateConversationFileQueries(queryClient, {
        conversationId,
        projectId: conversation?.projectId,
      });
    }, 3000);

    return () => clearInterval(interval);
  }, [
    conversationId,
    conversation?.messages,
    conversation?.projectId,
    messages.length,
    status,
    queryClient,
  ]);

  // Refresh the Files list and the conversation (for the artifact) whenever the
  // chat settles to "ready" — the initial open and the end of every turn. This
  // surfaces `download_file` outputs and picks up a rewritten artifact, so the
  // Files panel can follow the latest output.
  useEffect(() => {
    if (!conversationId || status !== "ready") return;
    invalidateConversationFileQueries(queryClient, {
      conversationId,
      projectId: conversation?.projectId,
    });
  }, [status, conversationId, conversation?.projectId, queryClient]);

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

  const handleSubmit: ArchestraPromptInputProps["onSubmit"] = (
    message,
    e,
    options,
  ) => {
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
      // Throw to keep the textarea and draft intact — see onSubmit contract
      // in ArchestraPromptInputProps. The submit button doubles as Stop while
      // streaming; treating that click as an accepted submit would clear any
      // follow-up the user had already started typing.
      throw new Error("stop-not-submit");
    }

    const { kind: connectivityKind } = connectivity.state;
    if (connectivityKind !== "online") {
      toast.error(offlineSubmitMessage(connectivityKind));
      // Throw to keep the textarea and draft intact (onSubmit contract): the
      // user keeps their message instead of losing it to a silent failure.
      throw new Error("offline-not-submit");
    }

    const hasText = message.text?.trim();
    const hasFiles = message.files && message.files.length > 0;
    // a skill slash command may be sent on its own, with no prompt or files
    const hasSkill = !!options?.skill;

    if (!sendMessage || (!hasText && !hasFiles && !hasSkill)) {
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
    const parts: ChatMessagePart[] = [];

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

    const skillToAttach = options?.skill;

    // Attach-once: captured app render diagnostics ride this message's
    // metadata and the store is drained — a regenerate never re-attaches.
    const appDiagnostics = drainAppDiagnostics();
    sendMessage?.({
      role: "user",
      parts: ensureNonEmptyParts(parts),
      metadata: {
        createdAt: new Date().toISOString(),
        ...(skillToAttach ? { skill: skillToAttach } : {}),
        ...(options?.sandboxCommand ? { sandboxCommand: true as const } : {}),
        ...(appDiagnostics.length > 0 ? { appDiagnostics } : {}),
      },
    });
  };

  const isBrowserPanelVisible = isBrowserPanelOpen && !isPlaywrightSetupVisible;
  const isRightPanelOpen =
    isArtifactOpen || isBrowserPanelVisible || isAppsTabOpen || isRunsTabOpen;

  // Keep the active-tab tracker in sync with which panel is actually shown,
  // so closing+reopening restores the user's last view.
  useEffect(() => {
    if (isRunsTabOpen) {
      setActiveRightTab("runs");
    } else if (isAppsTabOpen) {
      setActiveRightTab("apps");
    } else if (isBrowserPanelVisible && !isArtifactOpen) {
      setActiveRightTab("browser");
    } else if (isArtifactOpen) {
      setActiveRightTab("files");
    }
  }, [isArtifactOpen, isBrowserPanelVisible, isAppsTabOpen, isRunsTabOpen]);

  const openRightPanelTab = useCallback(
    (tab: RightPanelTab) => {
      // Each tab owns its open flag; selecting one clears the others.
      setActiveRightTab(tab);
      setIsArtifactOpen(tab === "files");
      setIsBrowserPanelOpen(tab === "browser");
      setIsAppsTabOpen(tab === "apps");
      setIsRunsTabOpen(tab === "runs");
      if (conversationId) {
        const keys = conversationStorageKeys(conversationId);
        localStorage.setItem(keys.rightPanelOpen, "true");
        localStorage.setItem(keys.rightPanelTab, tab);
      }
    },
    [conversationId],
  );

  const closeRightPanel = useCallback(() => {
    setIsArtifactOpen(false);
    setIsBrowserPanelOpen(false);
    setIsAppsTabOpen(false);
    setIsRunsTabOpen(false);
    if (conversationId) {
      // Leave the saved tab so reopening restores the last view.
      localStorage.setItem(
        conversationStorageKeys(conversationId).rightPanelOpen,
        "false",
      );
    }
  }, [conversationId]);

  // When you land on a scheduled-run chat, open the Runs tab once per
  // conversation (re-closing then sticks for that conversation).
  const autoOpenedRunsRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!scheduledRunTriggerId || !conversationId) return;
    if (autoOpenedRunsRef.current === conversationId) return;
    autoOpenedRunsRef.current = conversationId;
    openRightPanelTab("runs");
  }, [scheduledRunTriggerId, conversationId, openRightPanelTab]);

  // When a conversation has an app but no saved right-panel preference yet (the
  // user hasn't manually opened/closed it in this chat), open the Apps tab once
  // so the app shows immediately — e.g. landing on a freshly-seeded "open app"
  // chat. A manual override is respected; once opened, openRightPanelTab persists
  // the preference, so this never fights the restore effect.
  const autoOpenedAppsRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!conversationId || isLoadingConversation) return;
    if (mcpApps.length === 0) return;
    if (autoOpenedAppsRef.current === conversationId) return;
    autoOpenedAppsRef.current = conversationId;
    if (
      localStorage.getItem(
        conversationStorageKeys(conversationId).rightPanelOpen,
      ) !== null
    ) {
      return;
    }
    openRightPanelTab("apps");
  }, [
    conversationId,
    isLoadingConversation,
    mcpApps.length,
    openRightPanelTab,
  ]);

  const browserAutoOpenConversationRef = useRef<string | undefined>(undefined);
  const seenBrowserToolCallIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!conversationId) {
      browserAutoOpenConversationRef.current = undefined;
      seenBrowserToolCallIdsRef.current = new Set();
      return;
    }

    if (browserAutoOpenConversationRef.current !== conversationId) {
      browserAutoOpenConversationRef.current = conversationId;
      seenBrowserToolCallIdsRef.current = new Set(browserToolCallIds);
      return;
    }

    const seenBrowserToolCallIds = seenBrowserToolCallIdsRef.current;
    const hasNewBrowserToolCall = Array.from(browserToolCallIds).some(
      (toolCallId) => !seenBrowserToolCallIds.has(toolCallId),
    );

    seenBrowserToolCallIdsRef.current = new Set([
      ...seenBrowserToolCallIds,
      ...browserToolCallIds,
    ]);

    if (
      hasNewBrowserToolCall &&
      showBrowserButton &&
      !isPlaywrightSetupVisible
    ) {
      openRightPanelTab("browser");
    }
  }, [
    browserToolCallIds,
    conversationId,
    isPlaywrightSetupVisible,
    openRightPanelTab,
    showBrowserButton,
  ]);

  // Handle creating conversation from browser URL input (when no conversation exists)
  const createInitialConversation = useCallback(
    (
      onSuccess?: (newConversation: { id: string }) => void | Promise<void>,
      title?: string,
    ) => {
      if (createConversationMutation.isPending) {
        return false;
      }

      const input = buildCreateConversationInput({
        agentId: initialAgentId,
        modelId: initialModel,
        chatApiKeyId: initialApiKeyId,
        title,
        projectId: searchParams.get("project"),
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
      createConversationMutation,
      searchParams,
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

  const handleForkConversation = useCallback(async () => {
    if (!conversationId || !effectiveForkAgentId) {
      return;
    }

    const result = conversation?.share?.id
      ? await forkSharedConversationMutation.mutateAsync({
          shareId: conversation.share.id,
          agentId: effectiveForkAgentId,
        })
      : await forkConversationMutation.mutateAsync({
          conversationId,
          agentId: effectiveForkAgentId,
        });

    if (result) {
      setIsForkDialogOpen(false);
      router.push(`/chat/${result.id}`);
    }
  }, [
    conversationId,
    conversation?.share?.id,
    effectiveForkAgentId,
    forkConversationMutation,
    forkSharedConversationMutation,
    router,
  ]);

  const handleExportMarkdown = useCallback(() => {
    if (!conversationId || messages.length === 0) return;
    downloadConversationMarkdown({
      messages,
      conversationId,
      title: conversation?.title,
      agentName: conversation?.agent?.name,
    });
  }, [
    conversationId,
    messages,
    conversation?.title,
    conversation?.agent?.name,
  ]);

  // Core logic for starting a new conversation with a message
  const submitInitialMessage = useCallback(
    (message: Partial<PromptInputMessage>, options?: ChatSubmitOptions) => {
      if (isPlaywrightSetupVisible) return;
      const hasText = message.text?.trim();
      const hasFiles = message.files && message.files.length > 0;

      if (
        (!hasText && !hasFiles && !options?.skill) ||
        !initialAgentId ||
        createConversationMutation.isPending
      ) {
        return;
      }

      // Store the message (text, files, submit options) to send after the
      // conversation is created
      pendingPromptRef.current = message.text || "";
      pendingFilesRef.current = message.files || [];
      pendingSkillRef.current = options?.skill;
      pendingSandboxCommandRef.current = options?.sandboxCommand;

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
      }, message.text?.trim());
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
  const handleInitialSubmit: ArchestraPromptInputProps["onSubmit"] =
    useCallback(
      (message, e, options) => {
        e.preventDefault();
        const { kind: connectivityKind } = connectivity.state;
        if (connectivityKind !== "online") {
          toast.error(offlineSubmitMessage(connectivityKind));
          // Throw to keep the textarea and draft intact (onSubmit contract).
          throw new Error("offline-not-submit");
        }
        submitInitialMessage(message, options);
      },
      [submitInitialMessage, connectivity.state],
    );

  // A chat started from a project page keeps the Files panel open when the
  // project already has results — continuity with the project page, which
  // shows the same folder on its right side. Tracked through a ref (the files
  // query races conversation creation) and persisted per conversation, since
  // creation navigates to /chat/<id>, which remounts this component.
  const { data: startedFromProjectFiles } = useProjectFiles(
    searchParams.get("project") ?? undefined,
  );
  const projectHasFilesRef = useRef(false);
  useEffect(() => {
    if ((startedFromProjectFiles?.length ?? 0) > 0) {
      projectHasFilesRef.current = true;
    }
  }, [startedFromProjectFiles]);

  // Auto-send message from URL when conditions are met (deep link support)
  useEffect(() => {
    if (autoSendTriggeredRef.current) return;

    // A handoff that stashed attachments stamps `attachments=1` and may carry no
    // prompt (files-only), so it triggers the send too — but only when the files
    // are actually still in memory, else a reloaded handoff URL (store cleared)
    // would create an empty conversation.
    const handoffHasAttachments = searchParams.get("attachments") === "1";
    const handoffFilesReady =
      handoffHasAttachments && hasPendingChatHandoffFiles();
    if (!initialUserPrompt && !handoffFilesReady) return;

    // A skill deep link must finish staging before the auto-send fires, else
    // the first message would miss it. Processing strips skillId from the URL
    // (success, not-found, and error alike), which re-runs this effect.
    if (searchParams.get("skillId")) return;

    // Skip if conversation already exists
    if (conversationId) return;

    // Wait for agent to be ready.
    if (!initialAgentId) return;
    // Skip if mutation is already in progress
    if (createConversationMutation.isPending) return;

    // Mark as triggered to prevent duplicate sends
    autoSendTriggeredRef.current = true;
    clearUserPromptQueryParam({
      pathname,
      router,
      searchParams,
    });

    // Store the message to send after conversation is created. Draining is
    // gated on the URL marker so the shared auto-send path never pulls stashed
    // files into an unrelated handoff (app / SSO / a2a / deep link).
    pendingPromptRef.current = initialUserPrompt;
    pendingFilesRef.current = handoffHasAttachments
      ? drainPendingChatHandoffFiles()
      : [];

    createInitialConversation((newConversation) => {
      // the init effect on the /chat/<id> mount reads this preference and
      // opens the Files panel (the default tab) for the fresh project chat.
      if (projectHasFilesRef.current) {
        const keys = conversationStorageKeys(newConversation.id);
        localStorage.setItem(keys.rightPanelOpen, "true");
        localStorage.setItem(keys.rightPanelTab, "files");
      }
      selectConversation(newConversation.id);
    });
  }, [
    initialUserPrompt,
    conversationId,
    initialAgentId,
    createInitialConversation,
    selectConversation,
    createConversationMutation.isPending,
    pathname,
    router,
    searchParams,
  ]);

  useEffect(() => {
    if (
      autoSendTriggeredRef.current ||
      !initialUserPrompt ||
      !conversationId ||
      !sendMessage ||
      status !== "ready"
    ) {
      return;
    }

    autoSendTriggeredRef.current = true;

    clearUserPromptQueryParam({
      pathname,
      router,
      searchParams,
    });

    sendMessage({
      role: "user",
      parts: [{ type: "text", text: initialUserPrompt }],
      metadata: { createdAt: new Date().toISOString() },
    });
  }, [
    conversationId,
    initialUserPrompt,
    pathname,
    router,
    searchParams,
    sendMessage,
    status,
  ]);

  useEffect(() => {
    const pendingChatResume = getOAuthPendingChatResume();
    if (
      oauthReauthResumeTriggeredRef.current ||
      !pendingChatResume ||
      pendingChatResume.conversationId !== conversationId ||
      !sendMessage ||
      status !== "ready"
    ) {
      return;
    }

    oauthReauthResumeTriggeredRef.current = true;
    clearOAuthPendingChatResume();
    sendMessage({
      role: "user",
      parts: [{ type: "text", text: pendingChatResume.message }],
      metadata: { createdAt: new Date().toISOString() },
    });
  }, [conversationId, sendMessage, status]);

  // Check if the conversation's agent was deleted
  const isAgentDeleted = conversationId && conversation && !conversation.agent;

  // First-run onboarding: after the org's first provider key is added, offer to
  // set the org default model — which built-in background subagents inherit —
  // before the chat composer opens.
  //
  // This is a one-shot nudge, intentionally NOT a persistent gate: it fires only
  // in the same session, right after the first key is added (`firstKeyAdded`).
  // If the admin skips it or navigates away mid-onboarding, they are not
  // re-prompted on later visits — they set the default anytime in Settings →
  // Agents (which links here from its "Default Model" copy). Deriving it purely
  // from server state (keys exist && no org default) would re-show it on every
  // /chat visit until a default is set, which nags.
  //
  // Whether to show the step is derived from live org/permission state at render
  // (not captured in the callback closure), and `Boolean(organization)`
  // suppresses it while the org record is still loading — so a returning admin
  // who already has a default never flashes the step during that window.
  const { data: canSetDefaultModel } = useHasPermissions({
    agentSettings: ["update"],
  });
  const [firstKeyAdded, setFirstKeyAdded] = useState(false);
  const showDefaultModelStep =
    firstKeyAdded &&
    canSetDefaultModel === true &&
    Boolean(organization) &&
    !organization?.defaultModelId;
  const handleFirstKeyAdded = useCallback(() => {
    setFirstKeyAdded(true);
    // Reset to a clean /chat URL after a key is added so no stale conversation
    // param lingers; the keys query refetch reveals the composer.
    router.push("/chat");
  }, [router]);
  const finishFirstRunOnboarding = useCallback(() => {
    setFirstKeyAdded(false);
    router.push("/chat");
  }, [router]);

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

  // The first keys fetch failed with no cached list (e.g. offline cold start).
  // Show a retry state rather than the setup prompt, which would wrongly imply
  // the user has no keys configured. `isLoadingError` is scoped to the
  // first-fetch failure: a failed background refetch keeps the last successful
  // result, so we don't flip a working or known-empty screen to this one.
  if (isApiKeysLoadError) {
    return <ApiKeyLoadError onRetry={() => refetchApiKeys()} />;
  }

  // First-run step 2: after the first key exists, set the org default model on
  // the same onboarding backdrop before the composer opens. Checked before the
  // no-key branch so it wins the moment a key is added (before the keys query
  // has refetched), rather than flashing the add-key screen again.
  if (showDefaultModelStep) {
    return <DefaultModelOnboardingStep onDone={finishFirstRunOnboarding} />;
  }

  // If API key is not configured, show setup prompt with inline creation dialog
  if (!hasAnyApiKey) {
    return <NoApiKeySetup onKeyAdded={handleFirstKeyAdded} />;
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
              <Plus className="h-4 w-4" />
              Create Agent
            </ButtonWithTooltip>
          ) : (
            <Button asChild>
              <Link href="/agents?create=true">
                <Plus className="h-4 w-4" />
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

  // A chat opened via a handoff (project composer, app, SSO, a2a, deep link)
  // lands on /chat carrying a `user_prompt` (or a stashed-attachments marker),
  // auto-creates a conversation, then navigates to /chat/<id>. Rendering the
  // centered New Chat splash during that brief window flashes the empty home
  // before the conversation view mounts, so suppress it while the handoff runs.
  const isAutoSendHandoffPending = isAutoSendHandoffInProgress({
    conversationId,
    initialUserPrompt,
    hasAttachmentsMarker: searchParams.get("attachments") === "1",
    hasPendingHandoffFiles: hasPendingChatHandoffFiles(),
    autoSendTriggered: autoSendTriggeredRef.current,
    isCreatingConversation: createConversationMutation.isPending,
  });

  return (
    <AppsProvider
      key={conversationId ?? "new"}
      apps={mcpApps}
      onShowInPanel={() => openRightPanelTab("apps" as RightPanelTab)}
      onClosePanel={closeRightPanel}
    >
      <div className="flex flex-col h-full w-full min-h-0">
        {/* Full-width top bar: title + the Files/Browser/Apps tab strip. It
            sits above the [chat | panel] split so the panel's resize divider
            only spans the content area below it. */}
        <ConversationHeader
          conversationId={conversationId}
          conversation={conversation}
          messageCount={messages.length}
          isTitleAnimating={
            !!conversation && headerAnimatingTitles.has(conversation.id)
          }
          canManageShare={canManageShare}
          isShared={isShared}
          canCreateProject={canCreateProjectFromThisChat}
          scheduleTriggerId={scheduledRunTriggerId}
          onShare={() => setIsShareDialogOpen(true)}
          onExportMarkdown={handleExportMarkdown}
          onCreateProject={() => setIsCreateProjectOpen(true)}
          panel={{
            isOpen: isRightPanelOpen,
            activeTab: activeRightTab,
            scheduledRun,
            isArtifactOpen,
            isBrowserVisible: isBrowserPanelVisible,
            showBrowserButton,
            isPlaywrightSetupVisible,
            onClose: closeRightPanel,
            onOpenTab: openRightPanelTab,
          }}
        />
        <div className="flex flex-1 min-h-0">
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <div className="flex flex-col h-full min-h-0">
              <StreamTimeoutWarning status={status} messages={messages} />

              {/* Mobile: Inline artifact/browser panel below header */}
              {isRightPanelOpen && (
                <div className="flex-1 flex flex-col min-h-0 overflow-hidden md:hidden">
                  {activeRightTab === "files" && (
                    <div className="flex-1 min-h-0 overflow-auto">
                      <ConversationFilesPanel
                        key={conversationId ?? "none"}
                        conversationId={conversationId}
                        artifact={conversation?.artifact}
                        projectId={conversation?.projectId}
                        onClose={closeRightPanel}
                      />
                    </div>
                  )}
                  {activeRightTab === "browser" && isBrowserPanelVisible && (
                    <div className="flex-1 min-h-0 overflow-auto">
                      <BrowserPanel
                        isOpen
                        onClose={closeRightPanel}
                        conversationId={conversationId}
                        agentId={browserToolsAgentId}
                        onCreateConversationWithUrl={
                          handleCreateConversationWithUrl
                        }
                        isCreatingConversation={
                          createConversationMutation.isPending
                        }
                        initialNavigateUrl={pendingBrowserUrl}
                        onInitialNavigateComplete={
                          handleInitialNavigateComplete
                        }
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
                      isRightPanelOpen && "hidden md:block",
                    )}
                  >
                    {isScheduledRunInProgress ? (
                      <ScheduledRunInProgress />
                    ) : isReadOnlyConversation ? (
                      <MessageThread
                        messages={sharedConversationMessages}
                        chatErrors={conversation?.chatErrors ?? []}
                        conversationId={conversationId}
                        containerClassName="h-full"
                        hideDivider
                        profileId={conversation?.agent?.id}
                        agentName={conversation?.agent?.name}
                        selectedModel={conversation?.modelId ?? undefined}
                      />
                    ) : (
                      <ChatMessages
                        conversationId={conversationId}
                        agentId={
                          currentProfileId || initialAgentId || undefined
                        }
                        messages={messages}
                        status={status}
                        isContextCompacting={isContextCompacting}
                        contextCompactionFeedback={manualCompactionFeedback}
                        optimisticToolCalls={optimisticToolCalls}
                        isLoadingConversation={isLoadingConversation}
                        onMessagesUpdate={setMessages}
                        agentName={
                          (currentProfileId
                            ? internalAgents.find(
                                (a) => a.id === currentProfileId,
                              )
                            : internalAgents.find(
                                (a) => a.id === initialAgentId,
                              )
                          )?.name
                        }
                        selectedModel={conversation?.modelId ?? initialModel}
                        modelSource={
                          conversationModelSource ?? initialModelSource
                        }
                        chatErrors={conversation?.chatErrors ?? []}
                        compactions={conversation?.compactions ?? []}
                        onRegenerateUserMessage={regenerateUserMessage}
                        onProviderConnected={handleProviderConnected}
                        onChatErrorRetry={handleChatErrorRetry}
                        error={error}
                        onToolApprovalResponse={
                          addToolApprovalResponse
                            ? ({ id, approved, reason }) => {
                                addToolApprovalResponse({
                                  id,
                                  approved,
                                  reason,
                                });
                              }
                            : undefined
                        }
                      />
                    )}
                  </div>

                  {isScheduledRunInProgress ? null : isReadOnlyConversation ? (
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

                                void handleForkConversation();
                              }}
                            >
                              <Plus className="h-4 w-4" />
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
                              The agent associated with this conversation has
                              been deleted.
                            </span>
                          </div>
                          <Button onClick={() => router.push("/chat")}>
                            <Plus className="h-4 w-4" />
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
                            selectedModel={conversation?.modelId ?? ""}
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
                            cachedTokens={tokenUsage?.cacheReadTokens}
                            maxContextLength={selectedModelContextLength}
                            contextWindow={contextWindow}
                            lastCompaction={contextCompaction?.lastCompaction}
                            inputModalities={selectedModelInputModalities}
                            agentLlmApiKeyId={
                              conversation?.agent?.llmApiKeyId ?? null
                            }
                            submitDisabled={isPlaywrightSetupVisible}
                            isContextCompacting={isContextCompacting}
                            onCompactConversation={handleCompactConversation}
                            isPlaywrightSetupVisible={isPlaywrightSetupVisible}
                            selectorAgentId={activeAgentId}
                            selectorAgentName={swappedAgentName ?? undefined}
                            onAgentChange={handleConversationAgentChange}
                            modelSource={conversationModelSource}
                            onResetModelOverride={
                              handleConversationResetModelOverride
                            }
                            agentRequiresPerUserConnect={
                              conversationPerUserConnect.needsConnect
                            }
                            agentModelDisplayName={
                              conversationPerUserConnect.needsConnect
                                ? conversationPerUserConnect.modelName
                                : undefined
                            }
                            prefillText={composerPrefill}
                            onPrefillApplied={handleComposerPrefillApplied}
                          />
                          <div className="text-center">
                            <Version inline />
                          </div>
                        </div>
                      </div>
                    )
                  )}
                </>
              ) : isAutoSendHandoffPending ? (
                /* Handoff auto-send in progress: render an empty pane instead of
                 the centered New Chat splash, so the empty home never flashes
                 before we navigate to /chat/<id>. */
                <div className="flex-1 min-h-0" />
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
                              internalAgents.find(
                                (a) => a.id === initialAgentId,
                              ) as Record<string, unknown> | undefined
                            )?.llmApiKeyId as string | null
                          }
                          submitDisabled={isPlaywrightSetupVisible}
                          isPlaywrightSetupVisible={isPlaywrightSetupVisible}
                          selectorAgentId={initialAgentId}
                          onAgentChange={handleInitialAgentChange}
                          modelSource={initialModelSource}
                          onResetModelOverride={handleResetModelOverride}
                          agentRequiresPerUserConnect={
                            initialPerUserConnect.needsConnect
                          }
                          agentModelDisplayName={
                            initialPerUserConnect.needsConnect
                              ? initialPerUserConnect.modelName
                              : undefined
                          }
                          prefillText={composerPrefill}
                          onPrefillApplied={handleComposerPrefillApplied}
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
          <div className="hidden md:flex h-full min-h-0">
            <RightSidePanel
              isOpen={isRightPanelOpen}
              activeTab={activeRightTab}
              onClose={closeRightPanel}
              canShowBrowser={showBrowserButton && !isPlaywrightSetupVisible}
              scheduledRun={scheduledRun}
              artifact={conversation?.artifact}
              projectId={conversation?.projectId}
              conversationId={conversationId}
              agentId={browserToolsAgentId}
              onCreateConversationWithUrl={handleCreateConversationWithUrl}
              isCreatingConversation={createConversationMutation.isPending}
              initialNavigateUrl={pendingBrowserUrl}
              onInitialNavigateComplete={handleInitialNavigateComplete}
            />
          </div>
        </div>

        <CustomServerRequestDialog
          isOpen={isDialogOpened("custom-request")}
          onClose={() => closeDialog("custom-request")}
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

        <CreateProjectFromChatDialog
          conversationId={conversationId ?? null}
          defaultName={
            conversation
              ? getConversationDisplayTitle(
                  conversation.title,
                  conversation.messages,
                )
              : ""
          }
          open={isCreateProjectOpen}
          onOpenChange={setIsCreateProjectOpen}
        />

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
                onClick={handleForkConversation}
                disabled={
                  !effectiveForkAgentId ||
                  forkConversationMutation.isPending ||
                  forkSharedConversationMutation.isPending
                }
              >
                {forkConversationMutation.isPending ||
                forkSharedConversationMutation.isPending
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
    </AppsProvider>
  );
}

export default function ChatPage() {
  return <ChatPageContent key="new-chat" />;
}

function clearUserPromptQueryParam(params: {
  pathname: string;
  router: ReturnType<typeof useRouter>;
  searchParams: URLSearchParams;
}) {
  const nextSearchParams = new URLSearchParams(params.searchParams.toString());
  nextSearchParams.delete("user_prompt");
  // The attachments marker is one-shot too: drop it once consumed so a remount
  // can't re-trigger a drain (which would now find an empty store).
  nextSearchParams.delete("attachments");
  const nextUrl = nextSearchParams.toString()
    ? `${params.pathname}?${nextSearchParams.toString()}`
    : params.pathname;
  params.router.replace(nextUrl);
}

// skillId is a one-shot deep-link param (same posture as user_prompt): drop it
// once the skill has been resolved and staged so it is never processed twice.
function clearSkillIdQueryParam(params: {
  pathname: string;
  router: ReturnType<typeof useRouter>;
  searchParams: URLSearchParams;
}) {
  const nextSearchParams = new URLSearchParams(params.searchParams.toString());
  nextSearchParams.delete("skillId");
  const nextUrl = nextSearchParams.toString()
    ? `${params.pathname}?${nextSearchParams.toString()}`
    : params.pathname;
  params.router.replace(nextUrl);
}

type ChatMessagePart =
  | { type: "text"; text: string }
  | { type: "file"; url: string; mediaType: string; filename?: string };

// a bare skill command carries no parts of its own; keep an empty text part
// so the message is well-formed and the backend can inject the skill
function ensureNonEmptyParts(parts: ChatMessagePart[]): ChatMessagePart[] {
  return parts.length === 0 ? [{ type: "text", text: "" }] : parts;
}
