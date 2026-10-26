"use client";

import type { UIMessage } from "@ai-sdk/react";
import {
  type ChatExternalMcpSkillMetadata,
  ChatExternalMcpSkillMetadataSchema,
  type ChatMessageFeedback,
  type ChatSkillMetadata,
  type ThinkingEffortSetting,
  toPlaceholderTitle,
} from "@archestra/shared";
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
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { scheduledRunContext } from "@/app/_parts/scheduled-run-sidebar.utils";
import {
  AgentRuntimeCredentialPrompt,
  AgentRuntimePreflightError,
} from "@/components/agent-run-credential-prompt";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { preloadResponseMarkdown } from "@/components/ai-elements/response";
import { ApiKeyLoadError } from "@/components/api-key-load-error";
import { AppLogo } from "@/components/app-logo";
import { ButtonWithTooltip } from "@/components/button-with-tooltip";
import { AgentConnectionNotice } from "@/components/chat/agent-connection-notice";
import { AppsProvider } from "@/components/chat/apps-context";
import {
  ChatLinkButton,
  MobileHeaderChatLinks,
} from "@/components/chat/chat-help-link";
import {
  collectBrowserToolCallIds,
  deriveAppFilesRevisions,
  openedAppMetadataFromApps,
} from "@/components/chat/chat-messages.utils";
import { ChatStatusAnnouncer } from "@/components/chat/chat-status-announcer";
import { useConversationActions } from "@/components/chat/conversation-actions";
import { ConversationHeader } from "@/components/chat/conversation-header";
import { EncryptedChatIcon } from "@/components/chat/encrypted-chat-icon";
import { InitialAgentSelector } from "@/components/chat/initial-agent-selector";
import {
  getComposerAnswer,
  takesComposerAnswer,
} from "@/components/chat/mcp-elicitation-fields";
import type { RightPanelTab } from "@/components/chat/right-side-panel";
import { StreamTimeoutWarning } from "@/components/chat/stream-timeout-warning";
import { useChatApps } from "@/components/chat/use-chat-apps";
import { LoadingState } from "@/components/loading";
import { getScheduledRunChatState } from "@/components/scheduled-tasks/schedule-run-state";
import { MobileScheduleRuns } from "@/components/scheduled-tasks/schedule-runs-panel";
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
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Version } from "@/components/version";
import {
  useAgentDefaultSuggestedPrompts,
  useChatAgents,
  useDefaultAgentId,
  useProfile,
} from "@/lib/agent.query";
import {
  runtimePreflightDisabledReason,
  useAgentRuntimePreflight,
  useStartAgentRun,
} from "@/lib/agent-runtime.query";
import { trackEvent } from "@/lib/analytics";
import { useApp } from "@/lib/app.query";
import { afterNextPaint } from "@/lib/app-interactive";
import {
  useHasPermissions,
  useScopedCapabilities,
  useSession,
} from "@/lib/auth/auth.query";
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
  fetchAgentMcpTools,
  fetchConversationEnabledTools,
  invalidateConversationFileQueries,
  useCompactConversation,
  useConversation,
  useConversationFiles,
  useCreateConversation,
  useHasPlaywrightMcpTools,
  useKeepViewedConversationRead,
  useRefreshConversationFilesAfterTurn,
  useStopChatStream,
  useUpdateConversation,
  useUpdateConversationEnabledTools,
} from "@/lib/chat/chat.query";
import { useSetChatMessageFeedback } from "@/lib/chat/chat-message.query";
import { chatMessageQueue } from "@/lib/chat/chat-message-queue";
import { useForkConversation } from "@/lib/chat/chat-share.query";
import { classifyChatSubmitAction } from "@/lib/chat/chat-submit-action";
import {
  applyFeedbackToMessages,
  conversationStorageKeys,
  getConversationDisplayTitle,
  getManualCompactionSkippedMessage,
  getMessageFeedback,
  mergePersistedMessageMetadata,
} from "@/lib/chat/chat-utils";
import { isConversationShared } from "@/lib/chat/conversation-sharing";
import { resolveEnabledToolIds } from "@/lib/chat/enabled-tools-selection";
import {
  generateEncryptedChatKey,
  isActionAvailableForConversation,
} from "@/lib/chat/encrypted-chat";
import { useChatSession, useGlobalChat } from "@/lib/chat/global-chat.context";
import { createLatestWriteQueue } from "@/lib/chat/latest-write-queue";
import {
  drainPendingChatHandoffFiles,
  hasPendingChatHandoffFiles,
} from "@/lib/chat/pending-chat-handoff-files";
import { takePendingProjectChatHandoff } from "@/lib/chat/pending-project-chat-handoff";
import {
  clearPendingActions,
  getPendingActions,
} from "@/lib/chat/pending-tool-state";
import { getQueueInterruptBlockedReason } from "@/lib/chat/queue-interrupt";
import { useStreamStall } from "@/lib/chat/stream-stall.hook";
import {
  foldConfirmedThinkingEffort,
  writePendingThinkingEffort,
} from "@/lib/chat/thinking-effort-cache";
import {
  agentNotRecommendedForModel,
  agentRequiresPerUserConnect,
  agentToolsUnavailableForModel,
  deriveModelSource,
  getAgentSubscriptionConnection,
  resolveConversationKeyForModel,
} from "@/lib/chat/use-chat-preferences";
import { useInitialChatModelState } from "@/lib/chat/use-initial-chat-model-state.hook";
import { useConfig, useFeature } from "@/lib/config/config.query";
import {
  type ConnectivityState,
  useConnectivity,
} from "@/lib/config/connectivity";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useIsMobile } from "@/lib/hooks/use-mobile";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { useStableCallback } from "@/lib/hooks/use-stable-callback";
import { useLlmModels, useLlmModelsByProvider } from "@/lib/llm-models.query";
import {
  type SupportedProvider,
  useAvailableLlmProviderApiKeys,
  useLlmProviderApiKeys,
} from "@/lib/llm-provider-api-keys.query";
import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";
import { useOrganization } from "@/lib/organization.query";
import { useProject, useProjectFiles } from "@/lib/projects/projects.query";
import { useResourcePermissions } from "@/lib/resource-permissions.query";
import { useScheduleTriggerRun } from "@/lib/schedule-trigger.query";
import { useSkill, useSkillsPaginated } from "@/lib/skills/skill.query";
import { cn } from "@/lib/utils/tailwind";
import { ViewTransition } from "@/lib/view-transition";
import {
  buildCreateConversationInput,
  isAutoSendHandoffInProgress,
  resolveChatModelState,
  resolvePreferredModelForProvider,
} from "./chat-initial-state";
import { composerMorph } from "./composer-morph";
import {
  AppsPanelContent,
  BrowserPanel,
  ChatMessages,
  ConversationFilesPanel,
  DefaultModelOnboardingStep,
  NoApiKeySetup,
  OnboardingWizardButton,
  preloadConversationParts,
  RightSidePanel,
} from "./lazy-parts";
import ArchestraPromptInput, {
  type ArchestraPromptInputProps,
  type ChatSubmitOptions,
} from "./prompt-input";
import { resolveSharedConversationForkState } from "./shared-conversation-fork";
import {
  buildSkillCommands,
  externalMcpSkillCommandValue,
  resolveUrlSkillAction,
} from "./skill-commands";
import {
  resolveSuggestionPreview,
  SuggestedPromptPills,
} from "./suggested-prompt-pills";

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
    case "database-unavailable":
      return "The database is unavailable — your message wasn't sent. Try again after the connection is restored.";
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
  const appName = useAppName();

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

  // A conversation has a transcript to render: fetch the markdown renderer
  // now, behind the composer, rather than on the next idle callback.
  useEffect(() => {
    if (!routeConversationId) return;
    afterNextPaint(() => {
      preloadConversationParts();
      void preloadResponseMarkdown();
    });
  }, [routeConversationId]);

  // Hide version display from layout - chat page has its own version display
  useEffect(() => {
    document.body.classList.add("hide-version");
    return () => document.body.classList.remove("hide-version");
  }, []);
  const [isArtifactOpen, setIsArtifactOpen] = useState(false);
  const [hasOpenedRightPanel, setHasOpenedRightPanel] = useState(false);
  // The composer's shared-element morph is for arriving from the centered
  // new-chat (or project) composer. Between two conversations the composer
  // stays put, and the morph only cost a document view transition that held
  // the new composer's first frames, so it is off there. Decided once per
  // mount, so the wrapper never changes under a composer holding a draft.
  const [morphComposer] = useState(() => composerMorph.shouldMorph());
  useEffect(() => {
    if (!routeConversationId) return;
    return composerMorph.registerConversationComposer();
  }, [routeConversationId]);
  const [isApplyingAgentSelection, setIsApplyingAgentSelection] =
    useState(false);
  const pendingPromptRef = useRef<string | undefined>(undefined);
  const pendingFilesRef = useRef<
    Array<{ url: string; mediaType: string; filename?: string }>
  >([]);
  // Skill invoked via slash command on the first message of a new chat,
  // held until the conversation exists and the message can be sent.
  const pendingSkillRef = useRef<ChatSkillMetadata | undefined>(undefined);
  const pendingExternalMcpSkillRef =
    useRef<ChatExternalMcpSkillMetadata | null>(null);
  // Sandbox-command marker (`!` prefix) on the first message of a new chat,
  // held the same way so the deferred send stamps metadata.sandboxCommand.
  const pendingSandboxCommandRef = useRef<true | undefined>(undefined);

  // Composer prefill from a Skill deep link; handed to the composer once and
  // cleared via onPrefillApplied.
  const [composerPrefill, setComposerPrefill] = useState<string | null>(null);
  const [hoveredSuggestionPrompt, setHoveredSuggestionPrompt] = useState<
    string | null
  >(null);
  const [externalMcpSkillAttachment, setExternalMcpSkillAttachment] =
    useState<ChatExternalMcpSkillMetadata | null>(null);
  const urlSkillProcessedRef = useRef(false);
  const urlExternalMcpSkillProcessedRef = useRef(false);
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

  const [isForkDialogOpen, setIsForkDialogOpen] = useState(false);
  const [forkAgentId, setForkAgentId] = useState<string | null>(null);
  const [manualCompactionFeedback, setManualCompactionFeedback] = useState<{
    status: "pending" | "success" | "skipped" | "failed";
    message: string;
  } | null>(null);
  const forkConversationMutation = useForkConversation();
  const { data: session } = useSession();

  const { data: canCreateAgent } = useHasPermissions({
    agent: ["create"],
  });
  const { data: canReadAgentGrant, isPending: isPermissionsPending } =
    useHasPermissions({
      agent: ["read"],
    });
  // Unknown while the session and its permissions load: the page renders
  // optimistically (on a session cookie) before either answers, and assumes
  // the common case until told otherwise rather than flashing a refusal.
  const canReadAgent = isPermissionsPending ? undefined : canReadAgentGrant;
  const { data: canReadLlmProvider } = useHasPermissions({
    llmProviderApiKey: ["read"],
  });
  const { data: canReadLlmModels } = useHasPermissions({
    llmModel: ["read"],
  });
  const { data: canSeeAgentPicker, isLoading: isAgentPickerPermissionLoading } =
    useHasPermissions({
      chat: ["full-view"],
    });

  const isMobile = useIsMobile();

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

  // Poll for schedule status/composer availability. Message deltas arrive via
  // the normal active-run replay stream, independently of this status poll.
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

  // The roster, key and model queries wait for the resolved permissions: a
  // role without these grants would otherwise get 403s from them. None of
  // them is on the path to the composer, which renders without them (the
  // agent and model chips fill in when they land).
  const hasChatAccess = !isPermissionsPending && canReadAgent !== false;
  const canUseProviderSettings =
    !isPermissionsPending &&
    canReadLlmProvider === true &&
    canReadLlmModels === true;

  const { data: conversation, isLoading: isLoadingConversation } =
    useConversation(conversationId);
  const { data: defaultAgentId } = useDefaultAgentId();
  const runtimeEnabled = useFeature("agentRuntime") === true;
  const startAgentRunMutation = useStartAgentRun();
  // Fetch profiles and models for initial chat (no conversation)
  const { modelsByProvider, isPending: isModelsLoading } =
    useLlmModelsByProvider({ enabled: canUseProviderSettings });
  const canLoadApiKeys = hasChatAccess && canUseProviderSettings;
  const {
    data: chatApiKeys = [],
    isLoading: isLoadingApiKeys,
    isPending: isApiKeysPending,
    isLoadingError: isApiKeysLoadError,
    refetch: refetchApiKeys,
  } = useLlmProviderApiKeys({
    enabled: canLoadApiKeys,
    toastOnError: false,
  });
  // The keys the viewer may use. A key shared as read-only is in the list
  // above but refused when a chat sends it, so the model/key pairing below
  // only ever picks from these (plus the agent's own key, which needs no
  // grant of its own).
  const {
    data: usableChatApiKeys = [],
    isLoading: isLoadingUsableApiKeys,
    isPending: isUsableApiKeysPending,
  } = useAvailableLlmProviderApiKeys({
    enabled: canLoadApiKeys,
    toastOnError: false,
  });
  const { data: organization, isPending: isOrgLoading } = useOrganization(
    true,
    { refetchInterval: 5000, refetchOnWindowFocus: "always" },
  );

  // A new chat started from a project (`/chat?project=<id>`) takes the
  // project's pinned agent. `isPending` stays true while the query is disabled,
  // so the loading gate only applies when there is a project to wait for.
  const newChatProjectId = searchParams.get("project");
  const { data: newChatProject, isPending: isNewChatProjectPending } =
    useProject(newChatProjectId ?? undefined);

  const {
    data: internalAgents = [],
    isPending: isLoadingAgents,
    resolveAgent,
  } = useChatAgents({
    enabled: hasChatAccess,
    ids: [
      searchParams.get("agentId"),
      newChatProject?.defaultAgent?.id,
      conversation?.agentId,
      conversation?.agent?.id,
      forkAgentId,
    ],
  });

  // Shared new-chat initialization (agent/model/key resolution + persistence).
  const {
    agentId: initialAgentId,
    isAgentResolving: isInitialAgentResolving,
    selectedAgent: initialAgentReference,
    modelId: initialModel,
    apiKeyId: initialApiKeyId,
    provider: initialProvider,
    modelSource: initialModelSource,
    setApiKeyId: setInitialApiKeyId,
    thinkingEffort: initialThinkingEffort,
    setThinkingEffort: setInitialThinkingEffort,
    onAgentChange: handleInitialAgentChange,
    onModelChange: handleInitialModelChange,
    onProviderChange: handleInitialProviderChange,
    onResetModelOverride: handleResetModelOverride,
  } = useInitialChatModelState({
    agents: internalAgents,
    resolveAgent,
    isAgentsLoading: isLoadingAgents,
    organization: organization ?? null,
    defaultAgentId,
    modelsByProvider,
    chatApiKeys: usableChatApiKeys,
    urlAgentId: searchParams.get("agentId"),
    urlModelId: searchParams.get("modelId"),
    projectDefaultAgentId: newChatProject?.defaultAgent?.id ?? null,
    canUseSavedAgent: canSeeAgentPicker === true,
    isPermissionResolving: isAgentPickerPermissionLoading,
    isOrgLoading,
    isProjectLoading: !!newChatProjectId && isNewChatProjectPending,
    isApiKeysLoading: isLoadingUsableApiKeys,
    routeConversationId,
  });
  const initialRuntimeCandidate =
    internalAgents.find((agent) => agent.id === initialAgentId) ??
    initialAgentReference;
  const initialRuntimeAgent =
    runtimeEnabled && initialRuntimeCandidate?.runtime
      ? initialRuntimeCandidate
      : undefined;
  const isInitialRuntimeMode = !!initialRuntimeAgent;
  const runtimePreflight = useAgentRuntimePreflight(
    initialAgentId ?? "",
    isInitialRuntimeMode,
  );

  // Whether the NEXT chat created from the new-chat composer is an encrypted chat.
  // Only meaningful pre-conversation; reset after a successful create so a
  // later new chat never inherits it silently.
  const [isEncryptedChatDraft, setIsEncryptedChatDraft] = useState(false);

  // `?encryptedChat=1` (command palette entry / Alt+I) arms the composer toggle.
  // One-shot, same posture as user_prompt and skillId: the param is stripped
  // once applied, so a reload can't silently re-arm it and a second Alt+I is a
  // real navigation rather than a no-op push of an identical URL.
  const urlEncryptedChatDraft = searchParams.get("encryptedChat") === "1";
  useEffect(() => {
    if (!urlEncryptedChatDraft) return;
    setIsEncryptedChatDraft(true);
    clearEncryptedChatQueryParam({ pathname, router, searchParams });
  }, [urlEncryptedChatDraft, pathname, router, searchParams]);

  const usableChatApiKeysRef = useRef(usableChatApiKeys);
  usableChatApiKeysRef.current = usableChatApiKeys;

  // Config decides whether a runtime agent can chat without a provider key,
  // so only the no-key screen waits for it (see below).
  const { data: config } = useConfig();
  const { data: chatModels = [] } = useLlmModels({
    enabled: !isPermissionsPending && canReadLlmModels === true,
  });

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
  const urlExternalMcpSkillId = searchParams.get("externalMcpSkillId");
  const urlExternalMcpServerId = searchParams.get("externalMcpServerId");
  const urlExternalMcpSkillUri = searchParams.get("externalMcpSkillUri");
  const urlExternalMcpSkillName = searchParams.get("externalMcpSkillName");
  const urlExternalMcpServerName = searchParams.get("externalMcpServerName");
  const urlExternalMcpSkillDisplayName = searchParams.get(
    "externalMcpSkillDisplayName",
  );
  const hasAnyExternalMcpSkillParam = !!(
    urlExternalMcpSkillId ||
    urlExternalMcpServerId ||
    urlExternalMcpSkillUri ||
    urlExternalMcpSkillName ||
    urlExternalMcpServerName ||
    urlExternalMcpSkillDisplayName
  );
  const urlSkillWanted = !!urlSkillId && !initialUserPrompt;
  const urlSkillQuery = useSkill(urlSkillWanted ? urlSkillId : null);
  const skillToolsEnabled = organization?.skillToolsEnabled ?? false;
  // Same query the composer's slash-command table is built from (identical
  // input → shared TanStack cache entry). The prefill token must come from
  // that table, not be re-derived from the skill name, so slug collisions
  // resolve to the right skill. Deep links land on a new chat, where the
  // composer's agent is the initial agent — so the same environment filter
  // (forAgentId) applies here; a cross-environment skill resolves
  // "unavailable" rather than prefilling a token the composer can't parse.
  const urlSkillCommandsQuery = useSkillsPaginated(
    {
      limit: 100,
      forAgentId: initialAgentId ?? undefined,
      includeContent: false,
    },
    {
      enabled:
        (urlSkillWanted || hasAnyExternalMcpSkillParam) &&
        skillToolsEnabled &&
        !!initialAgentId,
    },
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

  useEffect(() => {
    if (
      urlExternalMcpSkillProcessedRef.current ||
      !hasAnyExternalMcpSkillParam
    ) {
      return;
    }
    if (
      skillToolsEnabled &&
      initialAgentId &&
      !urlSkillCommandsQuery.isSuccess &&
      !urlSkillCommandsQuery.isError
    ) {
      return;
    }
    urlExternalMcpSkillProcessedRef.current = true;
    clearExternalMcpSkillQueryParams({ pathname, router, searchParams });
    if (
      !urlExternalMcpSkillId ||
      !urlExternalMcpServerId ||
      !urlExternalMcpSkillUri ||
      !urlExternalMcpSkillName ||
      !urlExternalMcpServerName ||
      !urlExternalMcpSkillDisplayName
    ) {
      toast.error("This MCP Skill is not available in chat");
      return;
    }
    if (initialUserPrompt || urlSkillId) return;
    const parsed = ChatExternalMcpSkillMetadataSchema.safeParse({
      id: urlExternalMcpSkillId,
      mcpServerId: urlExternalMcpServerId,
      uri: urlExternalMcpSkillUri,
      name: urlExternalMcpSkillName,
      serverName: urlExternalMcpServerName,
      commandValue: externalMcpSkillCommandValue({
        skill: {
          name: urlExternalMcpSkillName,
          serverName: urlExternalMcpServerName,
        },
        skillCommands: urlSkillCommandsQuery.data?.data
          ? buildSkillCommands(urlSkillCommandsQuery.data.data)
          : [],
      }),
      displayName: urlExternalMcpSkillDisplayName,
    });
    if (parsed.success) {
      setExternalMcpSkillAttachment(parsed.data);
      setComposerPrefill(`${parsed.data.commandValue} `);
    } else {
      toast.error("This MCP Skill is not available in chat");
    }
  }, [
    urlExternalMcpSkillId,
    urlExternalMcpServerId,
    urlExternalMcpSkillUri,
    urlExternalMcpSkillName,
    urlExternalMcpServerName,
    urlExternalMcpSkillDisplayName,
    hasAnyExternalMcpSkillParam,
    initialUserPrompt,
    urlSkillId,
    pathname,
    router,
    searchParams,
    skillToolsEnabled,
    initialAgentId,
    urlSkillCommandsQuery.isSuccess,
    urlSkillCommandsQuery.isError,
    urlSkillCommandsQuery.data,
  ]);

  const handleComposerPrefillApplied = useCallback(() => {
    setComposerPrefill(null);
  }, []);
  const handleRemoveExternalMcpSkillAttachment = useCallback(() => {
    setExternalMcpSkillAttachment(null);
  }, []);

  // Update URL when conversation changes
  const selectConversation = useCallback(
    (id: string | undefined) => {
      // A React Transition so the <ViewTransition> boundaries below animate
      // the splash → conversation swap (plain setState swaps instantly).
      startTransition(() => setConversationId(id));
      if (id) {
        // Shallow-route to the canonical URL: history.pushState syncs
        // usePathname/useSearchParams without an RSC navigation, so this
        // instance keeps rendering the conversation it just started. A real
        // router.push to /chat/[conversationId] would mount that segment's
        // keyed page and remount everything mid-stream (visible flicker).
        // Refresh, deep links, and back/forward still resolve through the
        // /chat/[conversationId] route.
        window.history.pushState(null, "", `/chat/${id}`);
      } else {
        router.push("/chat");
      }
    },
    [router],
  );

  // After the shallow pushState above, this /chat instance stays mounted while
  // the URL reads /chat/<id> — so navigating back to /chat (sidebar "New
  // Chat", browser back) can land on this same instance instead of a fresh
  // mount. Derive the reset from the URL: when the pathname returns to /chat,
  // clear the selection so the New Chat splash renders again.
  const isNewChatUrl = !routeConversationId && pathname === "/chat";
  useEffect(() => {
    if (isNewChatUrl) {
      startTransition(() => setConversationId(undefined));
    }
  }, [isNewChatUrl]);

  // App render diagnostics are conversation-scoped: drop any leftovers when
  // switching conversations so they never attach to an unrelated send.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately re-runs on conversation switch
  useEffect(() => {
    clearAllAppDiagnostics();
  }, [conversationId]);

  usePageTitle(
    conversation
      ? getConversationDisplayTitle(conversation.title, conversation.messages)
      : "Chat",
  );
  const sessionCapabilities = useScopedCapabilities();
  const canManageShare =
    !!conversationId &&
    !!conversation &&
    (conversation.userId === session?.user.id ||
      sessionCapabilities.data?.some(
        (grant) =>
          grant.resource === "conversation" &&
          grant.action === "manage-permissions" &&
          // A grant on every chat is project oversight; it never manages the
          // sharing of one chat.
          grant.scope === conversationId,
      ) === true) &&
    // Encrypted chats cannot be shared (the backend rejects it).
    isActionAvailableForConversation(conversation, "share");

  const sharingPolicy = useResourcePermissions(
    "conversation",
    conversationId ?? "",
    canManageShare === true,
  );
  const isShared = sharingPolicy.data
    ? isConversationShared({
        grants: sharingPolicy.data.grants,
        ownerId: conversation?.userId,
      })
    : !!conversation?.share;
  // Someone else's conversation. Decided only once the session is known: the
  // page renders before get-session answers (see WithAuthCheck), and an
  // unknown viewer must not hide the composer from the owner.
  const isReadOnlyConversation =
    !!conversationId &&
    !!conversation &&
    !!session?.user &&
    conversation.userId !== session.user.id;
  const persistedConversationMessages = useMemo(
    () => (conversation?.messages ?? []) as UIMessage[],
    [conversation?.messages],
  );
  // A document the server seeded carries only the end of a long conversation
  // (olderMessageCount says how much is left out); the full history follows
  // after paint. Its older messages then go in front of the live thread.
  const startedFromTail = useStartedFromTail(
    conversationId,
    conversation?.olderMessageCount,
  );
  const isWaitingForScheduledPrompt =
    conversation?.origin === "schedule_trigger" &&
    persistedConversationMessages.length === 0 &&
    (conversation.chatErrors?.length ?? 0) === 0;
  const shouldEnableChatSession =
    !!conversationId &&
    !isReadOnlyConversation &&
    !isWaitingForScheduledPrompt &&
    (!routeConversationId || !!conversation);
  const chatSession = useChatSession({
    conversationId: shouldEnableChatSession ? conversationId : undefined,
    initialMessages: persistedConversationMessages,
    enabled: shouldEnableChatSession,
  });
  const connectivity = useConnectivity();
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

  const conversationAgentSummary = internalAgents.find(
    (agent) => agent.id === conversation?.agentId,
  );
  const initialAgentSummary =
    internalAgents.find((agent) => agent.id === initialAgentId) ??
    initialAgentReference;
  const selectedAgentSummary = conversationId
    ? conversationAgentSummary
    : initialAgentSummary;
  // Only the active agent needs prompts, knowledge assignments, and resolved credentials.
  const selectedAgentQuery = useProfile(selectedAgentSummary?.id, {
    enabled: hasChatAccess,
  });
  const selectedAgentDetail =
    selectedAgentQuery.data &&
    selectedAgentQuery.data.id === selectedAgentSummary?.id
      ? selectedAgentQuery.data
      : undefined;
  const conversationAgent = conversationId ? selectedAgentDetail : undefined;
  const initialAgent = !conversationId ? selectedAgentDetail : undefined;
  const initialAgentHasOwnPrompts =
    (initialAgent?.suggestedPrompts?.length ?? 0) > 0;
  const { data: defaultSuggestedPrompts } = useAgentDefaultSuggestedPrompts(
    initialAgentId,
    { enabled: Boolean(initialAgent) && !initialAgentHasOwnPrompts },
  );
  const initialSuggestedPrompts = initialAgentHasOwnPrompts
    ? initialAgent?.suggestedPrompts
    : defaultSuggestedPrompts;
  const activeSelectionAgent = conversationId
    ? conversationAgent
    : initialAgent;
  const suggestionPreview = resolveSuggestionPreview(
    initialSuggestedPrompts,
    hoveredSuggestionPrompt,
  );
  const {
    data: activeAgentCredentials = [],
    isPending: isActiveAgentCredentialPending,
  } = useAvailableLlmProviderApiKeys({
    includeKeyId: activeSelectionAgent?.llmApiKeyId ?? undefined,
    enabled:
      canUseProviderSettings && Boolean(activeSelectionAgent?.llmApiKeyId),
    toastOnError: false,
  });
  const activeAgentSubscription = useMemo(
    () =>
      getAgentSubscriptionConnection({
        agent: activeSelectionAgent,
        credentials: activeAgentCredentials,
        userId: session?.user.id,
      }),
    [activeSelectionAgent, activeAgentCredentials, session?.user.id],
  );
  // Check if user has any API keys (including system keys for keyless providers
  // like Vertex AI Gemini, vLLM, or Ollama which don't require secrets).
  // Seeing a key is not enough to chat: a member whose keys are all shared
  // read-only gets a composer whose sends fail at the provider. Count only the
  // keys they may use, or the agent's own key, which works through the agent.
  // Unknown while the usable list loads, so the visible list (restored on
  // refresh) still decides the first paint.
  const hasAnyApiKey =
    // Until the permissions and then the keys arrive, keep the composer: the
    // no-provider screen shows only once the list has said there are none.
    // "No data yet", not "fetching": the render that enables the queries is
    // not fetching yet, and must not flash the no-provider screen.
    isPermissionsPending ||
    (((canLoadApiKeys && isApiKeysPending) || chatApiKeys.length > 0) &&
      // The usable list has not settled yet: keep the composer.
      ((canLoadApiKeys && isUsableApiKeysPending) ||
        // A key the viewer may use.
        usableChatApiKeys.length > 0 ||
        // Or the agent's own key, which works through the agent — unknown
        // until the roster has answered.
        Boolean(selectedAgentSummary?.llmApiKeyId) ||
        (hasChatAccess && isLoadingAgents)));
  const isAgentSubscriptionMetadataPending = Boolean(
    (selectedAgentSummary && !selectedAgentDetail) ||
      (activeSelectionAgent?.llmApiKeyId && isActiveAgentCredentialPending),
  );
  // An unconnected per-user subscription is stored as a null conversation
  // model/key pair. In that state the agent's pinned model remains the effective
  // UI selection until the viewer connects or deliberately chooses an override.
  const conversationModelId =
    conversation?.modelId ?? conversationAgent?.modelId ?? null;

  // Derive current provider from the effective selected model.
  const currentProvider = useMemo((): SupportedProvider | undefined => {
    if (!conversationModelId) return undefined;
    const model = chatModels.find((m) => m.dbId === conversationModelId);
    return model?.provider;
  }, [conversationModelId, chatModels]);

  // Model source — derived purely by comparing the selected model against the
  // agent's and org's configured defaults. No stored state, nothing to keep in sync.
  const conversationModelSource = useMemo(() => {
    return deriveModelSource({
      selectedModelId: conversationModelId,
      agentModelId: conversationAgent?.modelId,
      orgModelId: organization?.defaultModelId,
    });
  }, [
    conversationModelId,
    conversationAgent?.modelId,
    organization?.defaultModelId,
  ]);

  // A shared agent can pin a per-user-credential model (e.g. GitHub Copilot).
  // When the viewer hasn't connected their own account that model is not in
  // their available list; keep it selected (no silent swap) so sending it
  // can be blocked with an inline connect prompt instead of substituting
  // another provider.
  // Returns whether the per-user connect prompt applies and, if so, the agent's
  // resolved model name — so the read-only chip can show "gpt-4" instead of the
  // model's UUID (which the viewer can't resolve without access to the key).
  const initialPerUserConnect = useMemo(() => {
    return {
      needsConnect: agentRequiresPerUserConnect({
        agent: initialAgent,
        selectedModelId: initialModel,
        selectedModel: chatModels.find((m) => m.dbId === initialModel),
        requiresPerUserCredential: activeAgentSubscription.requiresConnection,
        isCredentialConnected: activeAgentSubscription.isConnected,
      }),
      modelName: initialAgent?.resolvedLlmModelName ?? undefined,
      provider: initialAgent?.resolvedLlmProvider,
      agentName: initialAgent?.name,
    };
  }, [initialAgent, initialModel, chatModels, activeAgentSubscription]);

  const conversationPerUserConnect = useMemo(() => {
    return {
      needsConnect: agentRequiresPerUserConnect({
        agent: conversationAgent,
        selectedModelId: conversationModelId,
        selectedModel: chatModels.find((m) => m.dbId === conversationModelId),
        requiresPerUserCredential: activeAgentSubscription.requiresConnection,
        isCredentialConnected: activeAgentSubscription.isConnected,
      }),
      modelName: conversationAgent?.resolvedLlmModelName ?? undefined,
      provider: conversationAgent?.resolvedLlmProvider,
      agentName: conversationAgent?.name,
    };
  }, [
    conversationAgent,
    conversationModelId,
    chatModels,
    activeAgentSubscription,
  ]);

  useEffect(() => {
    const catalogModel = chatModels.find(
      (model) => model.dbId === conversationModelId,
    );
    subscriptionDebug("effective conversation state", {
      routeConversationId: conversationId ?? null,
      conversationId: conversation?.id ?? null,
      conversationAgentId: conversation?.agentId ?? null,
      storedModelId: conversation?.modelId ?? null,
      storedChatApiKeyId: conversation?.chatApiKeyId ?? null,
      agentModelId: conversationAgent?.modelId ?? null,
      agentApiKeyId: conversationAgent?.llmApiKeyId ?? null,
      effectiveModelId: conversationModelId,
      modelSource: conversationModelSource,
      requiresUserConnection: catalogModel?.requiresUserConnection ?? null,
      isConnected: catalogModel?.isConnected ?? null,
      needsConnect: conversationPerUserConnect.needsConnect,
      subscriptionMetadataPending: isAgentSubscriptionMetadataPending,
      credentialRequiresConnection: activeAgentSubscription.requiresConnection,
      credentialConnected: activeAgentSubscription.isConnected,
      isApplyingAgentSelection,
      initialAgentId,
      initialModelId: initialModel,
      initialChatApiKeyId: initialApiKeyId,
      activeSelectionAgentId: activeSelectionAgent?.id ?? null,
      initialNeedsConnect: initialPerUserConnect.needsConnect,
    });
  }, [
    chatModels,
    conversationId,
    conversation?.agentId,
    conversation?.chatApiKeyId,
    conversation?.id,
    conversation?.modelId,
    conversationAgent?.llmApiKeyId,
    conversationAgent?.modelId,
    conversationModelId,
    conversationModelSource,
    conversationPerUserConnect.needsConnect,
    isApplyingAgentSelection,
    isAgentSubscriptionMetadataPending,
    activeAgentSubscription.isConnected,
    activeAgentSubscription.requiresConnection,
    activeSelectionAgent?.id,
    initialAgentId,
    initialApiKeyId,
    initialModel,
    initialPerUserConnect.needsConnect,
  ]);

  // A no-tools model (e.g. Microsoft 365 Copilot) paired with a tooled agent
  // runs tool-less — the backend omits the tools — so an up-front notice
  // above the composer replaces tools silently never firing.
  const initialToolsUnavailable = useMemo(
    () =>
      agentToolsUnavailableForModel({
        agent: initialAgent,
        selectedModelId: initialModel,
        models: chatModels,
      }),
    [initialAgent, initialModel, chatModels],
  );

  const conversationToolsUnavailable = useMemo(
    () =>
      agentToolsUnavailableForModel({
        agent: conversationAgent,
        selectedModelId: conversationModelId,
        models: chatModels,
      }),
    [conversationAgent, conversationModelId, chatModels],
  );

  // A small local model (e.g. a 4B Ollama tag) paired with a tooled agent will
  // usually still run the loop, just unreliably — so this warns where the
  // no-tools notice states, and defers to it when both would apply.
  const initialNotRecommended = useMemo(
    () =>
      agentNotRecommendedForModel({
        agent: initialAgent,
        selectedModelId: initialModel,
        models: chatModels,
      }),
    [initialAgent, initialModel, chatModels],
  );

  const conversationNotRecommended = useMemo(
    () =>
      agentNotRecommendedForModel({
        agent: conversationAgent,
        selectedModelId: conversationModelId,
        models: chatModels,
      }),
    [conversationAgent, conversationModelId, chatModels],
  );

  // Get selected model's context length for the context indicator
  const selectedModelContextLength = useMemo((): number | null => {
    const modelId = conversationId ? conversationModelId : initialModel;
    if (!modelId) return null;
    const model = chatModels.find((m) => m.dbId === modelId);
    return model?.capabilities?.contextLength ?? null;
  }, [conversationId, conversationModelId, initialModel, chatModels]);

  // Get selected model's input modalities for file upload filtering
  const selectedModelInputModalities = useMemo(() => {
    const modelId = conversationId ? conversationModelId : initialModel;
    if (!modelId) return null;
    const model = chatModels.find((m) => m.dbId === modelId);
    return model?.capabilities?.inputModalities ?? null;
  }, [conversationId, conversationModelId, initialModel, chatModels]);

  // Mutation for updating conversation model
  // Use a ref so callbacks don't recreate when mutation state changes (isPending etc.),
  // which would cause infinite re-render loops via Radix composeRefs during commit phase.
  const updateConversationMutation = useUpdateConversation();
  const updateConversationMutateRef = useRef(updateConversationMutation.mutate);
  updateConversationMutateRef.current = updateConversationMutation.mutate;
  const updateConversationMutateAsyncRef = useRef(
    updateConversationMutation.mutateAsync,
  );
  updateConversationMutateAsyncRef.current =
    updateConversationMutation.mutateAsync;

  // Handle model change — use refs for chatModels and conversation to keep
  // callback reference stable. A new callback reference would re-trigger
  // ModelSelector's auto-select effect on every chatModels refetch.
  const chatModelsRef = useRef(chatModels);
  chatModelsRef.current = chatModels;
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  // Picking a model also pins the API key it runs through: a conversation
  // stores the (model, key) pair as a unit, so a model is never persisted
  // without its key. Keep the conversation's current key when it serves the
  // model's provider, otherwise use a key the viewer may use for that provider.
  const handleModelChange = useCallback((modelId: string) => {
    const conv = conversationRef.current;
    if (!conv) return;
    const model = chatModelsRef.current.find((m) => m.dbId === modelId);
    const chatApiKeyId = resolveConversationKeyForModel({
      currentKeyId: conv.chatApiKeyId,
      // A stored (model, key) pair shares one provider, so the current
      // model tells which provider the agent's own key serves.
      currentModelProvider: chatModelsRef.current.find(
        (m) => m.dbId === conv.modelId,
      )?.provider,
      agentApiKeyId: conv.agent?.llmApiKeyId,
      modelProvider: model?.provider,
      usableKeys: usableChatApiKeysRef.current,
    });
    subscriptionDebug("model change", {
      source: "conversation-model-selector",
      conversationId: conv.id,
      previousModelId: conv.modelId,
      previousChatApiKeyId: conv.chatApiKeyId,
      nextModelId: modelId,
      nextChatApiKeyId: chatApiKeyId,
    });
    updateConversationMutateRef.current({
      id: conv.id,
      modelId,
      chatApiKeyId,
    });
  }, []);

  // The composer's own state is the one source for the depth. Finishing a
  // message invalidates the conversation query, so the row cannot hold an
  // unconfirmed pick — the refetch would hand back the value the persist request
  // has not reached yet and silently undo the click.
  // Boxed so that picking auto — which is itself null — is distinguishable from
  // having nothing pending.
  const [pendingThinkingEffort, setPendingThinkingEffortState] = useState<{
    effort: ThinkingEffortSetting;
  } | null>(null);
  const settlePendingThinkingEffortRef = useRef(
    (effort: ThinkingEffortSetting) => {
      // Leaves a newer pick alone — it owns the control now.
      setPendingThinkingEffortState((current) =>
        current?.effort === effort ? null : current,
      );
    },
  );
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;

  const thinkingEffortQueueRef = useRef(
    createLatestWriteQueue<{
      conversationId: string;
      effort: ThinkingEffortSetting;
    }>(async ({ conversationId: id, effort }) => {
      const updated = await updateConversationMutateAsyncRef.current({
        id,
        thinkingEffort: effort,
      });
      if (updated) {
        foldConfirmedThinkingEffort(queryClientRef.current, id, effort);
      }
      // callApi reports a failure and resolves with null, so a rejected write
      // arrives here too; dropping the pick falls the control back to the row.
      settlePendingThinkingEffortRef.current(effort);
    }),
  );

  // A different chat has its own depth; carrying this one's pick across would
  // show the wrong value and send it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on conversation switch — conversationId is the trigger, not a read
  useEffect(() => {
    setPendingThinkingEffortState(null);
  }, [conversationId]);

  // Turns the composer does not send itself — a queued message draining, a
  // regenerate — read the pick from here rather than from this component.
  // Cleared on the way out too: a pick left behind for a chat the user has
  // navigated away from would still be read by a turn draining for that chat,
  // long after the composer forgot it.
  useEffect(() => {
    if (!conversationId) return;
    writePendingThinkingEffort(
      queryClient,
      conversationId,
      pendingThinkingEffort,
    );
    return () => {
      writePendingThinkingEffort(queryClient, conversationId, null);
    };
  }, [conversationId, pendingThinkingEffort, queryClient]);

  const displayedThinkingEffort = pendingThinkingEffort
    ? pendingThinkingEffort.effort
    : conversation?.thinkingEffort;

  const handleThinkingEffortChange = useCallback(
    (effort: ThinkingEffortSetting) => {
      const conv = conversationRef.current;
      if (!conv) return;
      setPendingThinkingEffortState({ effort });
      thinkingEffortQueueRef.current.set({
        conversationId: conv.id,
        effort,
      });
    },
    [],
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
      subscriptionDebug("provider credential change", {
        conversationId: conversation.id,
        provider: newProvider,
        chatApiKeyId: apiKeyId,
        preferredModelId: preferredModel?.modelId ?? null,
      });
      if (preferredModel) {
        updateConversationMutateRef.current({
          id: conversation.id,
          chatApiKeyId: apiKeyId,
          modelId: preferredModel.modelId,
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
      subscriptionDebug("agent change start", {
        conversationId: conversation.id,
        previousAgentId: conversation.agentId,
        nextAgentId: agentId,
        previousModelId: conversation.modelId,
        previousChatApiKeyId: conversation.chatApiKeyId,
      });
      setIsApplyingAgentSelection(true);
      updateConversationMutateRef.current(
        {
          id: conversation.id,
          agentId,
        },
        {
          onSettled: (data, error) => {
            subscriptionDebug("agent change settled", {
              responseAgentId: data?.agentId ?? null,
              responseModelId: data?.modelId ?? null,
              responseChatApiKeyId: data?.chatApiKeyId ?? null,
              error: error ? String(error) : null,
            });
            setIsApplyingAgentSelection(false);
          },
        },
      );
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
      chatApiKeys: usableChatApiKeys,
      organization: organization
        ? {
            defaultModelId: organization.defaultModelId,
            defaultLlmApiKeyId: organization.defaultLlmApiKeyId,
          }
        : null,
    });
    const agentModel = chatModels.find(
      (model) => model.dbId === agent?.modelId,
    );
    const resetsToUnconnectedSubscription = Boolean(
      agentModel?.requiresUserConnection && !agentModel.isConnected,
    );
    subscriptionDebug("reset override start", {
      conversationId: conversation.id,
      agentId: conversation.agentId,
      storedModelId: conversation.modelId,
      storedChatApiKeyId: conversation.chatApiKeyId,
      agentModelId: agent?.modelId ?? null,
      resolvedModelId: resolved?.modelId ?? null,
      resolvedChatApiKeyId: resolved?.apiKeyId ?? null,
      requiresUserConnection: agentModel?.requiresUserConnection ?? null,
      isConnected: agentModel?.isConnected ?? null,
      resetsToUnconnectedSubscription,
    });

    if (resetsToUnconnectedSubscription) {
      // The backend stores an unresolved per-user subscription as a null pair;
      // the agent's pinned model remains the effective UI selection.
      setIsApplyingAgentSelection(true);
      updateConversationMutateRef.current(
        {
          id: conversation.id,
          modelId: null,
          chatApiKeyId: null,
        },
        {
          onSettled: (data, error) => {
            subscriptionDebug("reset override settled", {
              responseModelId: data?.modelId ?? null,
              responseChatApiKeyId: data?.chatApiKeyId ?? null,
              error: error ? String(error) : null,
            });
            setIsApplyingAgentSelection(false);
          },
        },
      );
    } else if (resolved) {
      setIsApplyingAgentSelection(true);
      updateConversationMutateRef.current(
        {
          id: conversation.id,
          modelId: resolved.modelId,
          chatApiKeyId: resolved.apiKeyId,
        },
        {
          onSettled: (data, error) => {
            subscriptionDebug("reset override settled", {
              responseModelId: data?.modelId ?? null,
              responseChatApiKeyId: data?.chatApiKeyId ?? null,
              error: error ? String(error) : null,
            });
            setIsApplyingAgentSelection(false);
          },
        },
      );
    }
  }, [
    conversation,
    internalAgents,
    modelsByProvider,
    usableChatApiKeys,
    chatModels,
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
            includeEarlierPersisted: startedFromTail,
          })
        : persistedConversationMessages,
    [chatSession?.messages, persistedConversationMessages, startedFromTail],
  );
  const mcpApps = useChatApps({
    messages,
    earlyToolUiStarts: chatSession?.earlyToolUiStarts ?? {},
    filterDeleted: true,
  });
  // Count of agent copies into each open app's file store, recomputed as tool
  // results stream in; a bump makes the mounted app runtime nudge the running
  // app to re-list (no manual refresh to see a file the agent just copied in).
  const { getToolShortName } = useArchestraMcpIdentity();
  const appFilesRevisions = useMemo(
    () => deriveAppFilesRevisions(messages, getToolShortName),
    [messages, getToolShortName],
  );
  // Latest ui/update-model-context report per app ("showing file X"), stamped
  // onto outgoing message metadata at send time so the backend can tell the
  // model what the open app is displaying. A ref, not state: an app can
  // report on every file it reads, and the only reader is the send path —
  // re-rendering the whole chat page per report would be pure waste.
  const appModelContextsRef = useRef<Map<string, string>>(new Map());
  const handleAppModelContext = useCallback((appId: string, text: string) => {
    appModelContextsRef.current.set(appId, text);
  }, []);
  // The owned apps this conversation renders. Sharing a chat does not share
  // them, so the share dialog uses this to warn when recipients won't be able
  // to open one.
  const conversationOwnedAppIds = useMemo(
    () => [
      ...new Set(mcpApps.flatMap((app) => (app.appId ? [app.appId] : []))),
    ],
    [mcpApps],
  );
  // The same actions as the chat's sidebar row menu.
  const conversationActions = useConversationActions({
    conversation,
    canShare: canManageShare,
    isShared,
    appIds: conversationOwnedAppIds,
  });
  // The app currently open in the chat, reported to the backend on each user
  // message so it can restate that app's context in the turn's system prompt.
  // The backend re-resolves the id under the caller's own access, so this is a
  // hint, never an authorization.
  const openedAppMetadata = useMemo(
    () => openedAppMetadataFromApps(mcpApps),
    [mcpApps],
  );
  // When an admin opens another user's app, the seeded conversation (origin
  // "app_open") renders that app, but its server-computed viewerRole is "admin":
  // they may use it and change its settings, not modify it via chat. Mirror the
  // Projects admin view by replacing the composer with a "Viewing as
  // administrator" banner. Gate on origin so useApp never fires for ordinary
  // chats, and read the same authoritative viewerRole the card/settings use.
  const oversightAppId =
    conversation?.origin === "app_open"
      ? (mcpApps.find((entry) => entry.appId)?.appId ?? null)
      : null;
  const oversightApp = useApp(oversightAppId);
  const isAppOversight = oversightApp.data?.viewerRole === "admin";
  // Hold the composer while an app-open conversation's app is still resolving so
  // an oversight view never briefly flashes an editable composer before we know.
  const isResolvingOversightApp =
    oversightAppId !== null && oversightApp.isPending;
  const sendMessage = chatSession?.sendMessage;
  const regenerateUserMessage = chatSession?.regenerateUserMessage;
  const isAwaitingScheduledStream =
    isScheduledRunInProgress &&
    chatSession?.status !== "streaming" &&
    chatSession?.status !== "submitted";
  const status = isAwaitingScheduledStream
    ? "submitted"
    : (chatSession?.status ?? "ready");
  const setMessages = chatSession?.setMessages;
  const stop = chatSession?.stop;
  const { isTransportStalled, isUpstreamIdle } = useStreamStall({
    status,
    transportActivitySequence: chatSession?.transportActivitySequence ?? 0,
    responseProgressSequence: chatSession?.responseProgressSequence ?? 0,
    messages,
  });

  // `status` here is read from the shared session map, which each
  // ChatSessionHook updates a render behind the real SDK status (via a
  // post-render sync effect + notifySessionUpdate). Right after handleSubmit
  // fires a direct send, the SDK is already busy but this `status` can still
  // read "ready" for a tick or two. Without a synchronous guard, rapid
  // follow-up submits take the direct-send path again and race each other
  // inside the single useChat instance — every message reaches the model, but
  // the concurrent sends clobber each other's optimistic user bubble, so most
  // never render. This latch makes only the first submit of a turn direct-send;
  // the rest enqueue and drain in order. Only meaningful with queueing on,
  // which is the sole path able to absorb the extra submits.
  const directSendPendingRef = useRef(false);
  // The real SDK status leaving "ready" means the direct send has landed and
  // this `status` snapshot will now gate follow-ups on its own; a conversation
  // switch retargets everything. Either way the latch has done its job.
  useEffect(() => {
    if (status !== "ready") {
      directSendPendingRef.current = false;
    }
  }, [status]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on conversation switch — the body writes a ref, so conversationId is a trigger, not a read
  useEffect(() => {
    directSendPendingRef.current = false;
  }, [conversationId]);

  // Thumbs feedback on assistant messages: optimistic apply + rollback against
  // the originating session's setter, captured here so a conversation switch
  // mid-request cannot retarget the rollback (or the invalidation, which the
  // mutation keys off its per-call variables). The rollback rides this
  // closure's own promise chain, NOT a mutation callback: switching
  // conversations remounts the page and unmounts the mutation observer, which
  // makes TanStack skip per-call callbacks — while the originating session
  // (and this closure's setter into it) lives on in the global chat context.
  const setChatMessageFeedback = useSetChatMessageFeedback();
  const handleMessageFeedback = useCallback(
    (messageId: string, feedback: ChatMessageFeedback | null) => {
      const applyMessages = setMessages;
      if (!applyMessages || !conversationId) {
        return;
      }
      const previousFeedback = getMessageFeedback(
        messages.find((message) => message.id === messageId),
      );
      applyMessages((current) =>
        applyFeedbackToMessages({ messages: current, messageId, feedback }),
      );
      setChatMessageFeedback
        .mutateAsync({ messageId, conversationId, feedback })
        .catch(() => {
          // Error toast already handled inside the mutation; only roll back —
          // and only while the message still shows THIS request's value, so a
          // slow failure can't overwrite a newer rating made in the meantime.
          applyMessages((current) => {
            const target = current.find((message) => message.id === messageId);
            if (getMessageFeedback(target) !== feedback) {
              return current;
            }
            return applyFeedbackToMessages({
              messages: current,
              messageId,
              feedback: previousFeedback,
            });
          });
        });
    },
    [setMessages, conversationId, messages, setChatMessageFeedback],
  );
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
  // the error. Owner-editable chats only (read-only viewers get no retry).
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
  const addToolApprovalResponse = chatSession?.addToolApprovalResponse;
  const optimisticToolCalls = chatSession?.optimisticToolCalls ?? [];
  const browserToolCallIds = useMemo(
    () =>
      collectBrowserToolCallIds({
        messages,
        optimisticToolCalls,
      }),
    [messages, optimisticToolCalls],
  );
  // Browser calls already in the saved thread are history: they never open
  // the panel, whenever they arrive (the end of a long conversation first,
  // its earlier messages after paint).
  const savedBrowserToolCallIds = useMemo(
    () =>
      collectBrowserToolCallIds({
        messages: persistedConversationMessages,
        optimisticToolCalls: [],
      }),
    [persistedConversationMessages],
  );
  const tokenUsage = chatSession?.tokenUsage;
  const contextTokensUsed = chatSession?.contextTokensUsed;
  const contextWindow = chatSession?.contextWindow ?? null;
  const contextCompaction = chatSession?.contextCompaction;
  const recordContextCompaction = chatSession?.recordContextCompaction;
  const beginManualContextCompaction =
    chatSession?.beginManualContextCompaction;
  const endManualContextCompaction = chatSession?.endManualContextCompaction;

  const syncPersistedMessageMetadata = useCallback(
    (persistedMessages: UIMessage[]) => {
      if (!setMessages) {
        return;
      }

      // Merge against the SDK's CURRENT thread via the functional updater — NOT
      // the `chatSession.messages` session snapshot, which trails the live SDK
      // thread by a render (it is published through a post-render sync effect;
      // see ChatSessionHook). During rapid queue drain that snapshot can be
      // missing the just-sent user message; folding a stale, shorter snapshot
      // and writing it back here would shrink the SDK thread and drop that
      // in-flight user message, while the ongoing stream only re-adds the
      // assistant reply — the user bubble then vanishes until a reload (the
      // backend persisted it fine). mergePersistedMessageMetadata returns the
      // same array reference when nothing changed, so React bails out.
      setMessages((current) =>
        mergePersistedMessageMetadata({
          liveMessages: current,
          persistedMessages,
          includeEarlierPersisted: startedFromTail,
        }),
      );
    },
    [setMessages, startedFromTail],
  );

  // Sync once the turn has settled — including a failed one. regenerate (and
  // the error card's "Try again") resolves the live message to its saved id
  // through this stamp; skipping it after an error left the just-sent message
  // unresolvable, so regenerating it silently did nothing.
  useEffect(() => {
    if (status === "submitted" || status === "streaming") {
      return;
    }

    syncPersistedMessageMetadata(persistedConversationMessages);
  }, [persistedConversationMessages, status, syncPersistedMessageMetadata]);

  const conversationAgentId =
    conversation?.agentId ?? conversation?.agent?.id ?? null;
  // While a conversation loads, its agent is unknown. Standing in the new-chat
  // default there painted an unrelated agent on reload, then swapped it.
  const fallbackAgentId = isLoadingConversation ? null : initialAgentId;
  const activeAgentId = conversationAgentId ?? fallbackAgentId;
  const isActiveAgentResolving =
    !activeAgentId && (isLoadingConversation || isInitialAgentResolving);
  const promptAgentId = conversation?.agent?.id ?? activeAgentId;
  // The resolved agent only: a stand-in would load another agent's detail
  // and readiness while the choice resolves.
  const newChatAgentId = activeAgentId ?? null;

  // Get current agent info
  const currentProfileId = conversationAgentId;
  const browserToolsAgentId = isReadOnlyConversation
    ? undefined
    : conversationId
      ? (conversationAgentId ?? promptAgentId ?? undefined)
      : (initialAgentId ?? undefined);

  // Browser setup fans out through the agent's tools, delegations, enabled
  // subagents, and installation state. On a new chat none of that can affect
  // the first useful composer render, so let the roster and model settle first
  // instead of making those requests compete with initialization.
  const shouldCheckBrowserTools =
    !!browserToolsAgentId &&
    (Boolean(conversationId) || (!isLoadingAgents && !isModelsLoading));

  const { hasPlaywrightMcpTools, isLoading: isLoadingBrowserTools } =
    useHasPlaywrightMcpTools(browserToolsAgentId, {
      enabled: shouldCheckBrowserTools,
    });
  const { data: canUpdateAgent } = useHasPermissions(
    { agent: ["update"] },
    browserToolsAgentId ?? "",
  );
  // Show while loading so it doesn't flash hidden for members whose agent already has playwright
  // tools. Once loading is done, hides only if the user lacks permission AND agent has no tools.
  const showBrowserButton =
    organization?.playwrightMcpEnabled === true &&
    !isReadOnlyConversation &&
    (canUpdateAgent ||
      hasPlaywrightMcpTools ||
      (!!conversationId && isLoadingConversation) ||
      (!!browserToolsAgentId && isLoadingBrowserTools));

  // Stream usage and compaction results both update this live context estimate.
  // Until this tab sees one, fall back to the saved size of the latest turn so
  // an opened chat shows its context usage right away.
  const tokensUsed =
    contextTokensUsed ??
    tokenUsage?.totalTokens ??
    conversation?.contextTokensUsed ??
    undefined;
  const isContextCompacting =
    !!contextCompaction?.isCompacting || compactConversationMutation.isPending;

  // Stable identity: passed to the memoized composer (see handleSubmit).
  const handleCompactConversation = useStableCallback(async () => {
    // The composer stays usable for the whole compaction, so `/compact` is
    // reachable again while one is already running — this guard is what stops
    // a second run re-entering.
    if (!conversationId || isReadOnlyConversation || isContextCompacting) {
      return;
    }

    setManualCompactionFeedback({
      status: "pending",
      message: "Compacting conversation context...",
    });

    // Mark the conversation busy for the whole REST round-trip. A manual
    // compaction has no stream to carry compaction-start/finish parts, so
    // without this the session would consider the conversation idle and both
    // send a composer submit straight into the rewrite and drain the queue on
    // top of it. Cleared in the `finally` below on every exit path.
    beginManualContextCompaction?.();
    try {
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
    } finally {
      endManualContextCompaction?.();
    }
  });

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
      !!pendingSkillRef.current ||
      !!pendingExternalMcpSkillRef.current;
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
    const externalMcpSkillToSend = pendingExternalMcpSkillRef.current;
    const sandboxCommandToSend = pendingSandboxCommandRef.current;
    pendingPromptRef.current = undefined;
    pendingFilesRef.current = [];
    pendingSkillRef.current = undefined;
    pendingExternalMcpSkillRef.current = null;
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
    // This effect fires right after the splash → conversation swap commits,
    // while its view transition (the composer morph) is still animating. An
    // urgent update here would make React skip that animation mid-flight, so
    // schedule the optimistic user-message append as a transition too — it
    // joins the running animation instead of snapping it to the end.
    startTransition(() => {
      sendMessage({
        role: "user",
        parts: ensureNonEmptyParts(parts),
        metadata: {
          createdAt: new Date().toISOString(),
          ...(skillToSend ? { skill: skillToSend } : {}),
          ...(externalMcpSkillToSend
            ? { externalMcpSkill: externalMcpSkillToSend }
            : {}),
          ...(sandboxCommandToSend ? { sandboxCommand: true as const } : {}),
          ...(initialAppDiagnostics.length > 0
            ? { appDiagnostics: initialAppDiagnostics }
            : {}),
        },
      });
    });

    trackEvent("message_sent", {
      conversationId,
      agentId: conversation.agentId ?? undefined,
      messageLength: promptToSend?.length ?? 0,
      fileCount: filesToSend.length,
      hasSkill: !!skillToSend || !!externalMcpSkillToSend,
    });
    for (const file of filesToSend) {
      trackEvent("file_uploaded", {
        mediaType: file.mediaType,
        conversationId,
      });
    }
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

  // Surface `download_file` outputs and a rewritten artifact when a turn ends,
  // so the Files panel can follow the latest output.
  useRefreshConversationFilesAfterTurn({
    conversationId,
    projectId: conversation?.projectId,
    status,
  });

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

  // The composer is memoized so streamed chunks (which re-render this page)
  // skip it; its handlers therefore keep one identity across renders while
  // still reading the latest messages/status when invoked.
  const handleStopStreaming = useStableCallback(() => {
    if (conversationId) {
      stop?.({
        preserveQueuedMessages: true,
        stopServer: () => stopChatStreamMutation.mutateAsync(conversationId),
      });
    } else {
      stop?.();
    }
  });

  const handleInterruptQueue = useStableCallback(() => {
    if (!conversationId) return;
    stop?.({
      preserveQueuedMessages: true,
      interruptQueued: true,
      stopServer: () => stopChatStreamMutation.mutateAsync(conversationId),
    });
  });

  const handleSubmit = useStableCallback<
    Parameters<ArchestraPromptInputProps["onSubmit"]>,
    ReturnType<ArchestraPromptInputProps["onSubmit"]>
  >(async (message, e, options) => {
    e.preventDefault();

    // Enqueue this submission instead of sending it now (throws on an empty
    // submit, keeping the composer intact per the onSubmit contract). Only
    // reached when queueing is on and a conversation exists.
    const enqueueSubmission = () => {
      if (!conversationId) return;
      const queueText = message.text?.trim();
      const queueFiles = (message.files ?? []).map((file) => ({
        url: file.url,
        mediaType: file.mediaType,
        ...(file.filename ? { filename: file.filename } : {}),
      }));
      if (
        !queueText &&
        queueFiles.length === 0 &&
        !options?.skill &&
        !options?.externalMcpSkill
      ) {
        // Nothing to queue (Enter on an empty composer while streaming).
        throw new Error("empty-queue-submit");
      }
      chatMessageQueue.enqueue(conversationId, {
        text: message.text ?? "",
        ...(queueFiles.length > 0 ? { files: queueFiles } : {}),
        ...(options?.skill ? { skill: options.skill } : {}),
        ...(options?.externalMcpSkill
          ? { externalMcpSkill: options.externalMcpSkill }
          : {}),
        ...(options?.sandboxCommand ? { sandboxCommand: true as const } : {}),
      });
      trackEvent("message_queued", {
        conversationId,
        agentId: conversation?.agentId ?? undefined,
        messageLength: message.text?.length ?? 0,
        fileCount: queueFiles.length,
      });
    };

    // An open single-pick question takes the composer's text as its typed
    // answer instead of a new message waiting behind it in the queue.
    const composerAnswer =
      chatSession &&
      !message.files?.length &&
      !options?.skill &&
      !options?.externalMcpSkill &&
      !options?.sandboxCommand
        ? getComposerAnswer({
            requests: chatSession.pendingMcpElicitations ?? [],
            text: message.text ?? "",
          })
        : null;
    if (composerAnswer && chatSession) {
      if (!(await chatSession.resolveMcpElicitation(composerAnswer))) {
        // Already reported; keep the text for another try (onSubmit contract).
        throw new Error("elicitation-answer-not-saved");
      }
      return;
    }

    const queueEnabled = !!conversationId;
    const submitAction = classifyChatSubmitAction({
      status,
      queueEnabled,
      directSendPending: directSendPendingRef.current,
      isCompacting: isContextCompacting,
      sessionPending: !sendMessage,
    });

    if (submitAction === "stop") {
      // No conversation to queue into (new-chat composer): the submit button
      // doubles as Stop while a turn streams. (Stopping is the submit button's
      // onClick, not a form submit.) Throw to keep the textarea and draft
      // intact — see onSubmit contract in ArchestraPromptInputProps.
      handleStopStreaming();
      throw new Error("stop-not-submit");
    }

    if (submitAction === "queue") {
      // The conversation is busy — streaming, a direct send still settling, or
      // a context compaction rewriting the thread. Queue the message; the
      // conversation's ChatSessionHook sends it once the conversation is idle
      // again. Returning normally clears the textarea and draft, like a send.
      enqueueSubmission();
      return;
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
    const hasExternalMcpSkill = !!options?.externalMcpSkill;

    if (
      !sendMessage ||
      (!hasText && !hasFiles && !hasSkill && !hasExternalMcpSkill)
    ) {
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
    const externalMcpSkillToAttach = options?.externalMcpSkill;

    // Attach-once: captured app render diagnostics ride this message's
    // metadata and the store is drained — a regenerate never re-attaches.
    const appDiagnostics = drainAppDiagnostics();
    // The open app's latest display report (owned apps only) rides along,
    // read from the ref at send time so "this file" resolves for the model.
    const openedAppModelContext =
      openedAppMetadata && "appId" in openedAppMetadata
        ? appModelContextsRef.current.get(openedAppMetadata.appId)
        : undefined;
    sendMessage?.({
      role: "user",
      parts: ensureNonEmptyParts(parts),
      metadata: {
        createdAt: new Date().toISOString(),
        ...(skillToAttach ? { skill: skillToAttach } : {}),
        ...(externalMcpSkillToAttach
          ? { externalMcpSkill: externalMcpSkillToAttach }
          : {}),
        ...(options?.sandboxCommand ? { sandboxCommand: true as const } : {}),
        ...(appDiagnostics.length > 0 ? { appDiagnostics } : {}),
        ...(openedAppMetadata
          ? {
              openedApp: openedAppModelContext
                ? { ...openedAppMetadata, modelContext: openedAppModelContext }
                : openedAppMetadata,
            }
          : {}),
      },
    });
    // Mark the turn as in flight synchronously so follow-up submits queue
    // instead of racing this send while the page's `status` catches up. Cleared
    // by the status/conversation effects above. Only latch when queueing can
    // absorb the overflow; otherwise leave the pre-existing (queue-off)
    // behavior untouched.
    if (queueEnabled) {
      directSendPendingRef.current = true;
    }

    trackEvent("message_sent", {
      conversationId,
      agentId: conversation?.agentId ?? undefined,
      messageLength: message.text?.length ?? 0,
      fileCount: message.files?.length ?? 0,
      hasSkill: !!skillToAttach || !!externalMcpSkillToAttach,
    });
    for (const file of message.files ?? []) {
      trackEvent("file_uploaded", {
        mediaType: file.mediaType ?? "unknown",
        conversationId,
      });
    }
  });

  const isBrowserPanelVisible =
    isBrowserPanelOpen && organization?.playwrightMcpEnabled === true;
  useEffect(() => {
    if (organization?.playwrightMcpEnabled === false) {
      setIsBrowserPanelOpen(false);
      setActiveRightTab((tab) => (tab === "browser" ? "files" : tab));
      setPendingBrowserUrl(undefined);
    }
  }, [organization?.playwrightMcpEnabled]);
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

  const openFilesPanel = useCallback(
    () => openRightPanelTab("files"),
    [openRightPanelTab],
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

    const seenBrowserToolCallIds = new Set([
      ...seenBrowserToolCallIdsRef.current,
      ...savedBrowserToolCallIds,
    ]);
    const hasNewBrowserToolCall = Array.from(browserToolCallIds).some(
      (toolCallId) => !seenBrowserToolCallIds.has(toolCallId),
    );

    seenBrowserToolCallIdsRef.current = new Set([
      ...seenBrowserToolCallIds,
      ...browserToolCallIds,
    ]);

    if (hasNewBrowserToolCall && showBrowserButton) {
      openRightPanelTab("browser");
    }
  }, [
    browserToolCallIds,
    savedBrowserToolCallIds,
    conversationId,
    openRightPanelTab,
    showBrowserButton,
  ]);

  // Handle creating conversation from browser URL input (when no conversation exists)
  const createInitialConversation = useCallback(
    (
      onSuccess?: (newConversation: { id: string }) => void | Promise<void>,
      title?: string,
    ) => {
      if (
        createConversationMutation.isPending ||
        isAgentSubscriptionMetadataPending
      ) {
        return false;
      }

      const input = buildCreateConversationInput({
        agentId: initialAgentId,
        modelId: initialModel,
        chatApiKeyId: initialApiKeyId,
        title,
        projectId: searchParams.get("project"),
        thinkingEffort: initialThinkingEffort,
      });
      if (!input) {
        return false;
      }
      // EncryptedChat: the conversation DEK is generated here, in the browser,
      // BEFORE the create request. It rides along as a header; the mutation's
      // onSuccess stores it under the fresh conversation id before any
      // navigation or stream start reads it.
      const encryptedChatKey = isEncryptedChatDraft
        ? generateEncryptedChatKey()
        : null;

      // Chained off the promise, not mutate's per-call onSuccess: an auto-send
      // can fire from the mount effect, and StrictMode's effect replay then
      // detaches the mutation observer, which silently drops per-call
      // callbacks (the conversation is created but never opened). Errors are
      // already reported by the hook.
      createConversationMutation
        .mutateAsync(
          encryptedChatKey
            ? { ...input, encryptedChat: true, encryptedChatKey }
            : input,
        )
        .then(
          (newConversation) => {
            if (!newConversation) return;
            setIsEncryptedChatDraft(false);
            void onSuccess?.(newConversation);
          },
          () => {},
        );
      return true;
    },
    [
      initialAgentId,
      initialModel,
      initialApiKeyId,
      isEncryptedChatDraft,
      initialThinkingEffort,
      isAgentSubscriptionMetadataPending,
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

    // A shared chat forks through the same route as an owned one: the server
    // lets anyone its permissions let read the chat start a copy.
    const result = await forkConversationMutation.mutateAsync({
      conversationId,
      agentId: effectiveForkAgentId,
    });

    if (result) {
      setIsForkDialogOpen(false);
      router.push(`/chat/${result.id}`);
    }
  }, [conversationId, effectiveForkAgentId, forkConversationMutation, router]);

  // Core logic for starting a new conversation with a message
  const submitInitialMessage = useCallback(
    (message: Partial<PromptInputMessage>, options?: ChatSubmitOptions) => {
      const hasText = message.text?.trim();
      const hasFiles = message.files && message.files.length > 0;

      if (
        (!hasText &&
          !hasFiles &&
          !options?.skill &&
          !options?.externalMcpSkill) ||
        isLoadingAgents ||
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
      pendingExternalMcpSkillRef.current = options?.externalMcpSkill ?? null;
      pendingSandboxCommandRef.current = options?.sandboxCommand;

      // Check if there are pending tool actions to apply.
      const pendingActions = initialAgentId
        ? getPendingActions(initialAgentId)
        : [];

      // The sidebar shows this until the server generates a real title — and
      // keeps it if generation fails.
      const placeholderTitle =
        toPlaceholderTitle(message.text ?? "") || undefined;

      createInitialConversation(async (newConversation) => {
        // Apply pending tool actions if any
        if (pendingActions.length > 0 && initialAgentId) {
          // Get the default enabled tools from the conversation (backend sets these)
          // We need to fetch them first to apply our pending actions on top
          try {
            // Fetch the conversation's default enabled-tools and the CURRENT
            // agent's tool set fresh — fetching the agent's tools here (rather
            // than reading a keepPreviousData hook) avoids persisting a previous
            // agent's tool IDs right after an agent switch.
            const [enabledToolsResult, agentTools] = await Promise.all([
              fetchConversationEnabledTools(newConversation.id),
              fetchAgentMcpTools(initialAgentId),
            ]);
            const allToolIds = agentTools.map((t) => t.id);
            // A fresh conversation carries no custom selection, so the pending
            // actions must apply on top of the agent's full tool set — not the
            // GET's empty array, which would turn "disable a subset" into
            // "enable nothing" and drop every tool. Without that set (agent has
            // no tools, or the fetch failed) the base is unknown, so leave the
            // conversation on its default rather than persist an empty allowlist.
            const canResolveBase =
              enabledToolsResult?.data?.hasCustomSelection ||
              allToolIds.length > 0;
            if (enabledToolsResult?.data && canResolveBase) {
              const newEnabledToolIds = resolveEnabledToolIds({
                hasCustomSelection: enabledToolsResult.data.hasCustomSelection,
                enabledToolIds: enabledToolsResult.data.enabledToolIds || [],
                allToolIds,
                pendingActions,
              });

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

              // Await the persist before the first message sends below: the
              // backend rebuilds the tool set from the DB, so a fire-and-forget
              // PUT could lose the race and run turn one with the just-declined
              // tool still enabled. This mutation resolves with null (it does not
              // throw) on API failure, so branch on the result rather than a
              // catch.
              const persisted = await updateEnabledToolsMutation.mutateAsync({
                conversationId: newConversation.id,
                toolIds: newEnabledToolIds,
              });
              if (persisted) {
                // Clear the pending action only once the selection is durable.
                clearPendingActions();
              } else {
                // Persist failed: undo the optimistic cache so it matches the DB,
                // and keep the pending action to retry on the next new
                // conversation rather than silently dropping the decline.
                queryClient.invalidateQueries({
                  queryKey: [
                    "conversation",
                    newConversation.id,
                    "enabled-tools",
                  ],
                });
              }
            }
          } catch {
            // Leave pending actions intact on failure; the first turn falls back
            // to the agent's default tools.
          }
        }

        selectConversation(newConversation.id);
      }, placeholderTitle);
    },
    [
      initialAgentId,
      createInitialConversation,
      isLoadingAgents,
      updateEnabledToolsMutation,
      selectConversation,
      queryClient,
      createConversationMutation.isPending,
    ],
  );

  // Form submit handler wraps submitInitialMessage with event.preventDefault
  const handleInitialSubmit: ArchestraPromptInputProps["onSubmit"] =
    useCallback(
      async (message, e, options) => {
        e.preventDefault();
        const { kind: connectivityKind } = connectivity.state;
        if (connectivityKind !== "online") {
          toast.error(offlineSubmitMessage(connectivityKind));
          // Throw to keep the textarea and draft intact (onSubmit contract).
          throw new Error("offline-not-submit");
        }
        if (isInitialRuntimeMode && initialAgentId) {
          const text = message.text?.trim() ?? "";
          if (!text) return;
          if (options) {
            toast.error("Chat commands aren't available in a run launcher.");
            throw new Error("run-input-not-supported");
          }
          const started = await startAgentRunMutation.mutateAsync({
            agentId: initialAgentId,
            message: text,
            files: message.files,
          });
          if (!started) throw new Error("run-not-started");
          router.push(`/chat/runs/${started.taskId}`);
          return;
        }
        submitInitialMessage(message, options);
      },
      [
        submitInitialMessage,
        connectivity.state,
        initialAgentId,
        isInitialRuntimeMode,
        router,
        startAgentRunMutation,
      ],
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

    if (!initialAgentId || isAgentSubscriptionMetadataPending) return;
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
    isAgentSubscriptionMetadataPending,
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
  // Chat (which links here from its "Default Model" copy). Deriving it purely
  // from server state (keys exist && no org default) would re-show it on every
  // /chat visit until a default is set, which nags.
  //
  // Whether to show the step is derived from live org/permission state at render
  // (not captured in the callback closure), and `Boolean(organization)`
  // suppresses it while the org record is still loading — so a returning admin
  // who already has a default never flashes the step during that window.
  const {
    data: canSetDefaultModel,
    isPending: isDefaultModelPermissionPending,
  } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const [firstKeyAdded, setFirstKeyAdded] = useState(false);
  const showDefaultModelStep =
    firstKeyAdded &&
    canSetDefaultModel === true &&
    Boolean(organization) &&
    !organization?.defaultModelId;
  // Navigating from a conversation URL remounts this page and discards the
  // one-shot flag. Keep the current route until the model step is completed.
  // If it does not apply, wait for permissions and the org before advancing.
  useEffect(() => {
    if (
      firstKeyAdded &&
      !isDefaultModelPermissionPending &&
      !isOrgLoading &&
      (!canSetDefaultModel || !organization || organization.defaultModelId)
    ) {
      setFirstKeyAdded(false);
      router.push("/chat");
    }
  }, [
    firstKeyAdded,
    isDefaultModelPermissionPending,
    isOrgLoading,
    canSetDefaultModel,
    organization,
    router,
  ]);
  const handleFirstKeyAdded = useCallback(() => {
    setFirstKeyAdded(true);
  }, []);
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

  // Nothing the composer shows holds the screen. The provider keys decide
  // between the composer and the connect-a-provider prompt, but nearly every
  // load has keys: the composer renders while they load, with the model
  // button and send waiting on them, and switches to the prompt only once the
  // list says there are none.
  //
  // The rest of what the composer needs fills in around it as well:
  //
  // - The agent roster. It is the largest thing the page fetches, and on a big
  //   organization it is over the refresh snapshot's per-query budget, so it is
  //   the one gate a reload could not skip. Until it lands the agent chip reads
  //   "Select agent" and submit is disabled — a toolbar that fills in, rather
  //   than a spinner where the page should be.
  // - The session, its permissions and the config. The page renders before
  //   any of them answer (see WithAuthCheck), so none of them may hold it.

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

  // If API key is not configured, show setup prompt with inline creation dialog.
  if (!hasAnyApiKey && !isInitialRuntimeMode) {
    // A runtime agent chats without a key, and the config says whether the
    // runtime is on: until it does, an empty key list is not yet the answer.
    if (!config) return <LoadingState variant="fill" />;
    return <NoApiKeySetup onKeyAdded={handleFirstKeyAdded} />;
  }

  // If no agents exist and we're not viewing a conversation with a deleted agent, show empty state.
  // `!isLoadingAgents` matters now that the roster no longer gates the screen:
  // an empty list means "none" only once it has actually loaded. Without it, an
  // organization with hundreds of agents would be told it has none for as long
  // as the roster takes to arrive.
  if (internalAgents.length === 0 && !isLoadingAgents && !isAgentDeleted) {
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
          {!canCreateAgent ? (
            <ButtonWithTooltip
              size="sm"
              disabled
              disabledText={"You don't have permission to create agents"}
            >
              <Plus className="h-4 w-4" />
              Create Agent
            </ButtonWithTooltip>
          ) : (
            <Button size="sm" asChild>
              <Link href="/agents/new">
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
            <Button size="sm" asChild>
              <Link href="/chat">Start a new chat</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // EncryptedChat tombstone: the conversation exists and the viewer may see it,
  // but this browser holds no (valid) encryption key, so the server returned
  // the locked view. Deliberately its own branch — this is not a 404, the
  // chat is real but undecryptable here.
  if (conversationId && conversation?.contentLocked) {
    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <Card className="w-full max-w-xl">
          <CardHeader className="justify-items-center text-center gap-3 pt-8">
            <EncryptedChatIcon className="mx-auto block size-14" />
            <CardTitle className="text-xl">
              This chat can&apos;t be unlocked
            </CardTitle>
            <CardDescription className="max-w-md text-sm leading-relaxed">
              This is an encrypted chat. Its encryption key existed only in the
              browser that created it and wasn&apos;t found here — clearing
              browser data or switching browsers removes the key. {appName}{" "}
              cannot decrypt the messages.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center pb-8">
            <Button size="sm" asChild>
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
  });

  // The side panel (files, browser, apps, artifact) is a lazy chunk of its
  // own; mounting it closed would fetch and evaluate it while the composer
  // hydrates. It mounts the first time it opens and stays (keeping its state).
  if (isRightPanelOpen && !hasOpenedRightPanel) setHasOpenedRightPanel(true);

  const page = (
    <AppsProvider
      key={conversationId ?? "new"}
      apps={mcpApps}
      onShowInPanel={() => openRightPanelTab("apps" as RightPanelTab)}
      onClosePanel={closeRightPanel}
      appFilesRevisions={appFilesRevisions}
      onAppModelContext={handleAppModelContext}
    >
      <div className="flex flex-col h-full w-full min-h-0">
        <ChatStatusAnnouncer status={status} />
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
          isAppOversight={isAppOversight}
          oversightOwnerName={oversightApp.data?.authorName ?? null}
          scheduleTriggerId={scheduledRunTriggerId}
          actionItems={conversationActions.items}
          panel={{
            isOpen: isRightPanelOpen,
            activeTab: activeRightTab,
            scheduledRun,
            isArtifactOpen,
            isBrowserVisible: isBrowserPanelVisible,
            isAppsVisible: isAppsTabOpen,
            showBrowserButton,
            onClose: closeRightPanel,
            onOpenTab: openRightPanelTab,
          }}
        />
        {selectedAgentSummary &&
          (selectedAgentQuery.isError ||
            (selectedAgentQuery.isSuccess && !selectedAgentQuery.data)) && (
            <InlineNotice variant="error">
              <AlertTriangle />
              <InlineNoticeText>
                Could not load the selected agent’s settings.
              </InlineNoticeText>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void selectedAgentQuery.refetch()}
              >
                Retry
              </Button>
            </InlineNotice>
          )}
        <div className="flex flex-1 min-h-0">
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <div className="flex flex-col h-full min-h-0">
              <StreamTimeoutWarning isStalled={isTransportStalled} />

              {/* Mobile: Inline artifact/browser panel below header */}
              {isRightPanelOpen && (
                <div className="flex-1 flex flex-col min-h-0 overflow-hidden md:hidden">
                  {activeRightTab === "runs" && scheduledRun && (
                    <MobileScheduleRuns
                      triggerId={scheduledRun.triggerId}
                      currentRunId={scheduledRun.runId}
                      onClose={closeRightPanel}
                    />
                  )}
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
                  {/* Gated on isMobile (not just CSS) so the app iframe only
                      ever mounts once — the desktop panel below unmounts on
                      mobile the same way. */}
                  {activeRightTab === "apps" && isMobile && (
                    <div className="flex-1 min-h-0 overflow-hidden">
                      <AppsPanelContent agentId={browserToolsAgentId} />
                    </div>
                  )}
                </div>
              )}

              {conversationId ? (
                <>
                  {/* Chat content - hidden on mobile when panels are open.
                      The ViewTransition eases the thread in when the splash
                      (or another page) hands off to a conversation. */}
                  <ViewTransition enter="chat-thread-enter" default="none">
                    <div
                      className={cn(
                        "flex-1 min-h-0 relative",
                        isRightPanelOpen && "hidden md:block",
                      )}
                    >
                      {isReadOnlyConversation && isScheduledRunInProgress ? (
                        <ScheduledRunInProgress />
                      ) : (
                        <ChatMessages
                          conversationId={conversationId}
                          readOnly={isReadOnlyConversation}
                          agentId={
                            currentProfileId || fallbackAgentId || undefined
                          }
                          messages={messages}
                          status={status}
                          isContextCompacting={isContextCompacting}
                          contextCompactionFeedback={manualCompactionFeedback}
                          isUpstreamIdle={isUpstreamIdle}
                          optimisticToolCalls={optimisticToolCalls}
                          isLoadingConversation={isLoadingConversation}
                          onMessagesUpdate={setMessages}
                          onMessageFeedback={
                            // No thumbs until the live session's setter exists —
                            // a click before then could not apply or roll back.
                            setMessages ? handleMessageFeedback : undefined
                          }
                          feedbackDisabled={setChatMessageFeedback.isPending}
                          agentName={
                            (currentProfileId
                              ? internalAgents.find(
                                  (a) => a.id === currentProfileId,
                                )
                              : internalAgents.find(
                                  (a) => a.id === fallbackAgentId,
                                )
                            )?.name ?? conversation?.agent?.name
                          }
                          selectedModel={
                            chatModels.find(
                              (m) =>
                                m.dbId ===
                                (conversationModelId ?? initialModel),
                            )?.id ??
                            conversationModelId ??
                            initialModel
                          }
                          modelSource={
                            conversationModelSource ?? initialModelSource
                          }
                          chatErrors={conversation?.chatErrors ?? []}
                          compactions={conversation?.compactions ?? []}
                          onRegenerateUserMessage={regenerateUserMessage}
                          // Both re-send the owner's last prompt, which a
                          // read-only viewer cannot do.
                          onProviderConnected={
                            isReadOnlyConversation
                              ? undefined
                              : handleProviderConnected
                          }
                          onChatErrorRetry={
                            isReadOnlyConversation
                              ? undefined
                              : handleChatErrorRetry
                          }
                          onTypeAnswer={
                            isReadOnlyConversation
                              ? undefined
                              : () => textareaRef.current?.focus()
                          }
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
                  </ViewTransition>

                  {/* The mobile Runs panel owns the content area while open. */}
                  {isMobile &&
                  isRightPanelOpen &&
                  activeRightTab === "runs" ? null : isReadOnlyConversation ? (
                    <div className={COMPOSER_DOCK_CLASS}>
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
                          {/* Forking is rejected for encrypted chats, so the
                              affordance is hidden rather than left to fail. */}
                          {isActionAvailableForConversation(
                            conversation,
                            "fork",
                          ) && (
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
                          )}
                        </div>
                        <div className="text-center">
                          <Version inline />
                        </div>
                      </div>
                    </div>
                  ) : isAgentDeleted ? (
                    <div className={COMPOSER_DOCK_CLASS}>
                      <div className="max-w-4xl mx-auto">
                        <div className="flex items-center justify-between gap-4 p-4 rounded-lg border border-muted bg-muted/50">
                          <div className="flex items-center gap-3 text-muted-foreground">
                            <AlertTriangle className="h-5 w-5 text-amber-500" />
                            <span>
                              The agent associated with this conversation has
                              been deleted.
                            </span>
                          </div>
                          <Button
                            size="sm"
                            onClick={() => router.push("/chat")}
                          >
                            <Plus className="h-4 w-4" />
                            New Conversation
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : isAppOversight || isResolvingOversightApp ? null : (
                    // Drawn while the conversation (and so its agent) is
                    // still loading, so it takes input from the first paint.
                    (activeAgentId || isLoadingConversation) && (
                      <div className={COMPOSER_DOCK_CLASS}>
                        {/* Shared-element pair with the centered New Chat
                            composer (and the project-page composer): on the
                            splash → conversation swap the box morphs from
                            center screen to its bottom anchor. */}
                        <ViewTransition
                          name={morphComposer ? "chat-composer" : undefined}
                          share={
                            morphComposer ? "chat-composer-morph" : undefined
                          }
                          default="none"
                        >
                          <div className="max-w-4xl mx-auto space-y-3">
                            {activeAgentId && (
                              <AgentConnectionNotice agentId={activeAgentId} />
                            )}
                            <ArchestraPromptInput
                              onSubmit={handleSubmit}
                              answersQuestion={takesComposerAnswer(
                                chatSession?.pendingMcpElicitations ?? [],
                              )}
                              toolsUnavailable={conversationToolsUnavailable}
                              notRecommendedForAgents={
                                conversationNotRecommended
                              }
                              onStop={handleStopStreaming}
                              onInterruptQueue={handleInterruptQueue}
                              isInterruptingQueue={
                                stopChatStreamMutation.isPending
                              }
                              interruptQueueDisabledReason={getQueueInterruptBlockedReason(
                                {
                                  messages,
                                  hasPendingQuestion:
                                    !!chatSession?.pendingMcpElicitations
                                      ?.length,
                                  isCompacting: isContextCompacting,
                                },
                              )}
                              status={status}
                              selectedModel={conversationModelId ?? ""}
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
                              isModelsLoading={
                                isModelsLoading || isLoadingApiKeys
                              }
                              tokensUsed={tokensUsed}
                              cachedTokens={tokenUsage?.cacheReadTokens}
                              maxContextLength={selectedModelContextLength}
                              contextWindow={contextWindow}
                              lastCompaction={contextCompaction?.lastCompaction}
                              inputModalities={selectedModelInputModalities}
                              agentLlmApiKeyId={
                                conversation?.agent?.llmApiKeyId ?? null
                              }
                              submitDisabled={
                                isWaitingForScheduledPrompt ||
                                isAwaitingScheduledStream ||
                                isApplyingAgentSelection
                              }
                              // Still loading what a send needs: the
                              // conversation's agent, its credentials, the
                              // provider keys. Typing is welcome meanwhile
                              // (the composer renders before any of them);
                              // only sending waits.
                              sendDisabled={
                                !activeAgentId ||
                                isAgentSubscriptionMetadataPending ||
                                isLoadingApiKeys
                              }
                              disabledReason={
                                isWaitingForScheduledPrompt ||
                                isAwaitingScheduledStream
                                  ? "Waiting for the scheduled run"
                                  : isApplyingAgentSelection
                                    ? "Switching agent…"
                                    : !activeAgentId
                                      ? "Loading the conversation…"
                                      : isAgentSubscriptionMetadataPending
                                        ? "Checking the agent's credentials…"
                                        : isLoadingApiKeys
                                          ? "Loading model providers…"
                                          : undefined
                              }
                              subscriptionConnectRequired={
                                conversationPerUserConnect.needsConnect
                              }
                              subscriptionProvider={
                                conversationPerUserConnect.provider
                              }
                              isContextCompacting={isContextCompacting}
                              onOpenFiles={
                                conversationId ? openFilesPanel : undefined
                              }
                              onCompactConversation={
                                isActionAvailableForConversation(
                                  conversation,
                                  "compaction",
                                )
                                  ? handleCompactConversation
                                  : undefined
                              }
                              selectorAgentId={activeAgentId}
                              isSelectorAgentResolving={isActiveAgentResolving}
                              onAgentChange={handleConversationAgentChange}
                              modelSource={conversationModelSource}
                              onResetModelOverride={
                                handleConversationResetModelOverride
                              }
                              thinkingEffort={displayedThinkingEffort}
                              onThinkingEffortChange={
                                handleThinkingEffortChange
                              }
                              agentRequiresPerUserConnect={
                                isApplyingAgentSelection ||
                                isAgentSubscriptionMetadataPending ||
                                conversationModelSource === "agent" ||
                                conversationPerUserConnect.needsConnect
                              }
                              agentModelDisplayName={
                                conversationPerUserConnect.needsConnect
                                  ? conversationPerUserConnect.modelName
                                  : undefined
                              }
                              prefillText={composerPrefill}
                              onPrefillApplied={handleComposerPrefillApplied}
                              externalMcpSkillAttachment={
                                externalMcpSkillAttachment
                              }
                              onRemoveExternalMcpSkillAttachment={
                                handleRemoveExternalMcpSkillAttachment
                              }
                              onRestoreExternalMcpSkillAttachment={
                                setExternalMcpSkillAttachment
                              }
                            />
                            <div className="text-center">
                              <Version inline />
                            </div>
                          </div>
                        </ViewTransition>
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
                /* No active chat: centered prompt input.
                   Rendered before `newChatAgentId` resolves, not after: the
                   roster it comes from is the biggest thing this page fetches,
                   and gating the composer on it is what put a spinner where the
                   landing page should be. The composer's chrome does not depend
                   on the agent — the chip reads "Select agent" until it lands
                   and the caller holds submit disabled — so it draws now and
                   fills in. */

                /* The exit fade covers the splash decoration (logo,
                     suggestions) when a conversation takes over; the composer
                     below is excluded — it carries its own shared name and
                     morphs to the bottom-anchored composer instead. */
                <ViewTransition exit="chat-splash-exit" default="none">
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: click-to-focus container */}
                  {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-focus container */}
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
                    {/* On mobile the splash buttons would overlap the logo,
                          so the links move into the app shell's header bar. */}
                    <MobileHeaderChatLinks
                      links={organization?.chatLinks ?? []}
                    />
                    {((organization?.chatLinks?.length ?? 0) > 0 ||
                      organization?.onboardingWizard) && (
                      <div className="absolute top-4 right-4 z-10 flex flex-wrap justify-end gap-2 max-w-[min(100%,36rem)]">
                        {organization?.chatLinks?.map((link) => (
                          <ChatLinkButton
                            key={`link-${link.label}-${link.url}`}
                            url={link.url}
                            label={link.label}
                            className="hidden md:inline-flex"
                          />
                        ))}
                        {organization?.onboardingWizard && (
                          <OnboardingWizardButton
                            wizard={organization.onboardingWizard}
                          />
                        )}
                      </div>
                    )}
                    <div className="flex-1 flex flex-col items-center justify-center p-4 gap-8">
                      <div className="scale-150">
                        <AppLogo />
                      </div>
                      {(() => {
                        if (isInitialRuntimeMode) return null;
                        const prompts = initialSuggestedPrompts;
                        if (!prompts || prompts.length === 0) return null;
                        return (
                          <SuggestedPromptPills
                            prompts={prompts}
                            disabled={
                              isAgentSubscriptionMetadataPending ||
                              (initialPerUserConnect.needsConnect &&
                                Boolean(initialPerUserConnect.provider))
                            }
                            onPreviewChange={setHoveredSuggestionPrompt}
                            onSelect={(sp) => {
                              trackEvent("prompt_selected", {
                                agentId: initialAgentId ?? undefined,
                                promptLength: sp.prompt.length,
                              });
                              submitInitialMessage({
                                text: sp.prompt,
                                files: [],
                              });
                            }}
                          />
                        );
                      })()}
                      <div className="w-full max-w-4xl space-y-3">
                        {/* Shared-element pair with the conversation composer —
                            see the bottom-anchored ViewTransition above. */}
                        <ViewTransition
                          name="chat-composer"
                          share="chat-composer-morph"
                          default="none"
                        >
                          <div className="w-full">
                            {newChatAgentId && !isInitialRuntimeMode && (
                              <div className="mb-3 empty:hidden">
                                <AgentConnectionNotice
                                  agentId={newChatAgentId}
                                />
                              </div>
                            )}
                            {/* Above the composer, like the connection
                                notice: what stops Send sits where the
                                reader looks before typing. */}
                            <div className="mb-3 empty:hidden">
                              {isInitialRuntimeMode &&
                                runtimePreflight.data?.ready === false && (
                                  <AgentRuntimeCredentialPrompt
                                    agentId={initialAgentId ?? ""}
                                    missing={[
                                      ...runtimePreflight.data.missing,
                                      ...runtimePreflight.data.misconfigured,
                                    ]}
                                    declarations={
                                      initialRuntimeAgent?.runtime
                                        ?.credentials ?? []
                                    }
                                    incompatible={
                                      runtimePreflight.data.incompatible
                                    }
                                    onConnected={() =>
                                      runtimePreflight.refetch()
                                    }
                                  />
                                )}
                              {isInitialRuntimeMode &&
                                runtimePreflight.isError && (
                                  <AgentRuntimePreflightError
                                    error={runtimePreflight.error}
                                    onRetry={() =>
                                      void runtimePreflight.refetch()
                                    }
                                  />
                                )}
                            </div>
                            <ArchestraPromptInput
                              drawerBelow
                              onSubmit={handleInitialSubmit}
                              placeholderPreview={suggestionPreview}
                              toolsUnavailable={initialToolsUnavailable}
                              notRecommendedForAgents={initialNotRecommended}
                              status={
                                createConversationMutation.isPending ||
                                startAgentRunMutation.isPending
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
                              isModelsLoading={
                                isModelsLoading || isLoadingApiKeys
                              }
                              inputModalities={selectedModelInputModalities}
                              agentLlmApiKeyId={
                                (
                                  internalAgents.find(
                                    (a) => a.id === initialAgentId,
                                  ) as Record<string, unknown> | undefined
                                )?.llmApiKeyId as string | null
                              }
                              // Still resolving which agent this chat
                              // starts on, or what tooling and credentials
                              // it brings. The draft is welcome — start
                              // typing straight away — it just has
                              // nowhere to go yet, and the submit handler
                              // refuses in this window anyway, so show
                              // that rather than letting a click land on
                              // nothing.
                              sendDisabled={
                                isLoadingAgents ||
                                isLoadingApiKeys ||
                                !initialAgentId ||
                                (!isInitialRuntimeMode &&
                                  isAgentSubscriptionMetadataPending) ||
                                (isInitialRuntimeMode &&
                                  (runtimePreflight.isPending ||
                                    runtimePreflight.data?.ready !== true))
                              }
                              disabledReason={
                                isLoadingAgents
                                  ? "Loading agents…"
                                  : isLoadingApiKeys
                                    ? "Loading model providers…"
                                    : !initialAgentId
                                      ? "No agent is available to you"
                                      : isInitialRuntimeMode
                                        ? runtimePreflightDisabledReason(
                                            runtimePreflight,
                                          )
                                        : isAgentSubscriptionMetadataPending
                                          ? "Checking the agent's credentials…"
                                          : undefined
                              }
                              subscriptionConnectRequired={
                                initialPerUserConnect.needsConnect
                              }
                              subscriptionProvider={
                                initialPerUserConnect.provider
                              }
                              selectorAgentId={initialAgentId}
                              isSelectorAgentResolving={isInitialAgentResolving}
                              onAgentChange={handleInitialAgentChange}
                              encryptedChat={
                                isInitialRuntimeMode
                                  ? false
                                  : isEncryptedChatDraft
                              }
                              onEncryptedChatChange={
                                isInitialRuntimeMode
                                  ? undefined
                                  : setIsEncryptedChatDraft
                              }
                              modelSource={initialModelSource}
                              onResetModelOverride={handleResetModelOverride}
                              thinkingEffort={initialThinkingEffort}
                              onThinkingEffortChange={setInitialThinkingEffort}
                              agentRequiresPerUserConnect={
                                isAgentSubscriptionMetadataPending ||
                                initialModelSource === "agent" ||
                                initialPerUserConnect.needsConnect
                              }
                              agentModelDisplayName={
                                initialPerUserConnect.needsConnect
                                  ? initialPerUserConnect.modelName
                                  : undefined
                              }
                              prefillText={composerPrefill}
                              onPrefillApplied={handleComposerPrefillApplied}
                              externalMcpSkillAttachment={
                                externalMcpSkillAttachment
                              }
                              onRemoveExternalMcpSkillAttachment={
                                handleRemoveExternalMcpSkillAttachment
                              }
                              onRestoreExternalMcpSkillAttachment={
                                setExternalMcpSkillAttachment
                              }
                              runtimeMode={isInitialRuntimeMode}
                              runtimeAgentName={initialRuntimeAgent?.name}
                            />
                          </div>
                        </ViewTransition>
                      </div>
                    </div>
                    <div className="p-4 text-center">
                      <Version inline />
                    </div>
                  </div>
                </ViewTransition>
              )}
            </div>
          </div>

          {/* Right-side panel - desktop only. Unmounted (not just CSS-hidden)
              on mobile so its Apps tab never hosts a second, invisible copy of
              the app iframe alongside the inline mobile panel above. */}
          {!isMobile && hasOpenedRightPanel && (
            <div className="hidden md:flex h-full min-h-0">
              <RightSidePanel
                isOpen={isRightPanelOpen}
                activeTab={activeRightTab}
                onClose={closeRightPanel}
                canShowBrowser={showBrowserButton}
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
          )}
        </div>

        {conversationActions.dialogs}

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
                  !effectiveForkAgentId || forkConversationMutation.isPending
                }
              >
                {forkConversationMutation.isPending
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
  return page;
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

// `encrypted-chat` arms the composer toggle once (command palette / Alt+I) and is
// then dropped, same one-shot posture as user_prompt and skillId.
function clearEncryptedChatQueryParam(params: {
  pathname: string;
  router: ReturnType<typeof useRouter>;
  searchParams: URLSearchParams;
}) {
  const nextSearchParams = new URLSearchParams(params.searchParams.toString());
  nextSearchParams.delete("encryptedChat");
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

// External MCP Skill identity is a one-shot attachment handoff. Remove every
// field once staged so refreshes cannot re-attach it after dismissal or send.
function clearExternalMcpSkillQueryParams(params: {
  pathname: string;
  router: ReturnType<typeof useRouter>;
  searchParams: URLSearchParams;
}) {
  const nextSearchParams = new URLSearchParams(params.searchParams.toString());
  nextSearchParams.delete("externalMcpSkillId");
  nextSearchParams.delete("externalMcpServerId");
  nextSearchParams.delete("externalMcpSkillUri");
  nextSearchParams.delete("externalMcpSkillName");
  nextSearchParams.delete("externalMcpServerName");
  nextSearchParams.delete("externalMcpSkillDisplayName");
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

function subscriptionDebug(event: string, data: Record<string, unknown>) {
  console.info(`[subscription-debug] ${event}`, data);
}

// No top padding, so messages run right down to the input's border; a short
// fade just above it keeps a line from being sliced in half there.
const COMPOSER_DOCK_CLASS =
  "sticky bottom-0 bg-background px-4 pb-4 before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-6 before:bg-gradient-to-t before:from-background before:to-transparent";

/**
 * Whether this conversation's first loaded snapshot was a tail read (it left
 * out older messages). Fixed per conversation: the full history replacing the
 * tail does not reset it.
 */
function useStartedFromTail(
  conversationId: string | undefined,
  olderMessageCount: number | undefined,
): boolean {
  const seen = useRef<{ id: string | undefined; fromTail: boolean } | null>(
    null,
  );
  if (seen.current?.id !== conversationId) {
    seen.current =
      olderMessageCount === undefined
        ? null
        : { id: conversationId, fromTail: olderMessageCount > 0 };
  }
  return seen.current?.fromTail ?? false;
}
