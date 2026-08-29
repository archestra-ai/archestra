"use client";

import {
  type ContextWindowBreakdown,
  E2eTestId,
  SUBSCRIPTION_CREDENTIALS,
  type SupportedProvider,
  subscriptionKindForProvider,
  type ThinkingEffortSetting,
} from "@archestra/shared";
import { MoreVerticalIcon, PaperclipIcon, XIcon } from "lucide-react";
import { memo, useCallback, useEffect } from "react";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import {
  PromptInputButton,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { AppRecordingControls } from "@/components/app-session-recording/app-recording-controls";
import { NotRecommendedForAgentsNoticeBadge } from "@/components/chat/agent-recommendation-notice";
import { ComposerBadge } from "@/components/chat/composer-badge";
import { ContextIndicator } from "@/components/chat/context-indicator";
import { ContextWindowDialog } from "@/components/chat/context-window-panel";
import { InitialAgentSelector } from "@/components/chat/initial-agent-selector";
import { LlmProviderApiKeySelector } from "@/components/chat/llm-provider-api-key-selector";
import { LockedChatIcon } from "@/components/chat/locked-chat-icon";
import { ModelSelector } from "@/components/chat/model-selector";
import { NoToolsModelBadge } from "@/components/chat/no-tools-model-notice";
import { ThinkingEffortSelector } from "@/components/chat/thinking-effort-selector";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  LOCKED_CHAT_DRAFT_SHORTCUT_EVENT,
  SHORTCUT_NEW_LOCKED_CHAT,
} from "@/consts";
import { useHasPermissions } from "@/lib/auth/auth.query";
import type { ModelSource } from "@/lib/chat/use-chat-preferences";
import { useModelSelectorDisplay } from "@/lib/chat/use-model-selector-display.hook";
import { useFeature } from "@/lib/config/config.query";
import { usePlatform } from "@/lib/hooks/use-platform";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { logoNameForProvider } from "@/lib/provider-logos";
import { cn } from "@/lib/utils";

export interface ChatPromptInputToolsProps {
  selectedModel: string;
  onModelChange: (model: string) => void;
  /** Optional - if not provided, it's initial chat mode (no conversation yet) */
  conversationId?: string;
  currentConversationChatApiKeyId?: string | null;
  currentProvider?: SupportedProvider;
  /** Selected API key ID for initial chat mode */
  initialApiKeyId?: string | null;
  /** Callback for API key change in initial chat mode (no conversation) */
  onApiKeyChange?: (apiKeyId: string) => void;
  /** Callback when user selects an API key with a different provider */
  onProviderChange?: (provider: SupportedProvider, apiKeyId: string) => void;
  /** Whether file uploads are allowed (controlled by organization setting) */
  allowFileUploads?: boolean;
  /**
   * Whether the next chat will be created locked-chat. New-chat composer only —
   * the toggle renders only while there is no conversation yet.
   */
  lockedChat?: boolean;
  /**
   * Provided only by the new-chat composer; together with the
   * `lockedChatEnabled` feature flag it enables the locked-chat toggle.
   */
  onLockedChatChange?: (lockedChat: boolean) => void;
  /** The composer launches an isolated Agent execution, not a chat turn. */
  executionMode?: boolean;
  /** Whether the agent has a code sandbox available (allows any file type) */
  sandboxAvailable?: boolean;
  /** Whether models are still loading - passed to API key selector */
  isModelsLoading?: boolean;
  /** Estimated tokens used in the conversation (for context indicator) */
  tokensUsed?: number;
  /** Input tokens served from the prompt cache on the latest response (for context indicator) */
  cachedTokens?: number;
  /** Maximum context length of the selected model (for context indicator) */
  maxContextLength?: number | null;
  /** Per-category breakdown of the assembled request (for context usage panel) */
  contextWindow?: ContextWindowBreakdown | null;
  /** Most recent compaction result, surfaced as a marker in the context panel */
  lastCompaction?: {
    originalTokenEstimate?: number;
    compactedTokenEstimate?: number;
    trigger?: "auto" | "manual";
  } | null;
  /** Summarize earlier turns on demand, from the context window panel */
  onCompactConversation?: () => Promise<void> | void;
  /** A compaction is already running (manual or automatic) */
  isContextCompacting?: boolean;
  /** Agent's configured LLM API key ID - passed to LlmProviderApiKeySelector */
  agentLlmApiKeyId?: string | null;
  /** Current agent ID for agent selector */
  selectorAgentId?: string | null;
  /** Callback when agent changes */
  onAgentChange?: (agentId: string) => void;
  /** Source of the currently selected model (agent, organization, user, or null) */
  modelSource?: ModelSource | null;
  /**
   * The selected model can't take tools while the agent has some — the turn
   * will run tool-less. Shown as a compact toolbar chip so the composer never
   * shifts when it toggles.
   */
  toolsUnavailable?: boolean;
  /**
   * The selected model is small enough that the agent's tools may be called
   * unreliably over a multi-step task. Same compact-chip treatment as
   * {@link toolsUnavailable}, and mutually exclusive with it.
   */
  notRecommendedForAgents?: boolean;
  /** Callback to reset user model override back to agent/org default */
  onResetModelOverride?: () => void;
  /** Reasoning depth for Gemini flash models; ignored by every other model. */
  thinkingEffort?: ThinkingEffortSetting;
  onThinkingEffortChange?: (effort: ThinkingEffortSetting) => void;
  /**
   * The selected agent pins a per-user-credential model (e.g. GitHub Copilot)
   * that the viewer hasn't connected. Keep the agent's model and subscription
   * selected so the connect prompt appears instead of silently switching.
   */
  agentRequiresPerUserConnect?: boolean;
  /** Keep credential controls visible while the selected subscription is unavailable. */
  subscriptionConnectRequired?: boolean;
  /** Provider whose personal subscription must be connected. */
  subscriptionProvider?: SupportedProvider;
  /** Open the selected subscription's connection flow. */
  onSubscriptionConnect?: () => void;
  /** Opens the pinned subscription connection dialog when incremented. */
  subscriptionConnectRequest?: number;
  /**
   * Server-resolved model name to show in the read-only chip when the agent's
   * per-user model isn't in the viewer's available models (avoids a raw UUID).
   */
  agentModelDisplayName?: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /**
   * Whether the toolbar should collapse its inline controls into a three-dots
   * menu. Decided by the parent based on whether they actually fit (measured on
   * the footer), so it also triggers when a side panel squeezes the input.
   */
  isNarrow: boolean;
  /**
   * Ref attached to the inline tools row so the parent can measure its natural
   * width and decide whether the controls still fit.
   */
  toolbarRef: React.RefObject<HTMLDivElement | null>;
}

const ChatPromptInputTools = memo(function ChatPromptInputTools({
  selectedModel,
  onModelChange,
  conversationId,
  currentConversationChatApiKeyId,
  currentProvider,
  initialApiKeyId,
  onApiKeyChange,
  onProviderChange,
  allowFileUploads = false,
  lockedChat = false,
  onLockedChatChange,
  executionMode = false,
  sandboxAvailable = false,
  isModelsLoading = false,
  tokensUsed = 0,
  cachedTokens,
  maxContextLength,
  contextWindow,
  lastCompaction,
  onCompactConversation,
  isContextCompacting = false,
  agentLlmApiKeyId,
  selectorAgentId,
  onAgentChange,
  modelSource,
  toolsUnavailable = false,
  notRecommendedForAgents = false,
  onResetModelOverride,
  thinkingEffort = null,
  onThinkingEffortChange,
  agentRequiresPerUserConnect = false,
  subscriptionConnectRequired = false,
  subscriptionProvider,
  onSubscriptionConnect,
  subscriptionConnectRequest = 0,
  agentModelDisplayName,
  textareaRef,
  isNarrow,
  toolbarRef,
}: ChatPromptInputToolsProps) {
  const attachments = usePromptInputAttachments();
  const providerCatalog = useModelProviderCatalog();

  // Collapsed/expanded state for the model selector (defaults to collapsed = provider icon only)
  const { isCollapsed: showDefaultLogo, expand: expandModelSelector } =
    useModelSelectorDisplay({ conversationId });

  const selectedApiKeyId = conversationId
    ? (currentConversationChatApiKeyId ?? null)
    : (initialApiKeyId ?? null);
  const { data: availableKeys } = useAvailableLlmProviderApiKeys({
    includeKeyId: selectedApiKeyId ?? undefined,
    toastOnError: false,
  });
  const selectedKeySubscriptionKind =
    availableKeys?.find((key) => key.id === selectedApiKeyId)
      ?.subscriptionKind ?? null;
  const logoProvider = currentProvider
    ? logoNameForProvider(currentProvider, selectedKeySubscriptionKind)
    : null;
  const providerToConnect = subscriptionProvider ?? currentProvider;
  const subscriptionKind = providerToConnect
    ? subscriptionKindForProvider(providerToConnect)
    : null;
  const subscriptionSignInTitle = subscriptionKind
    ? SUBSCRIPTION_CREDENTIALS[subscriptionKind].connect.signInTitle
    : `Sign in with ${
        providerToConnect
          ? providerCatalog.label(providerToConnect)
          : "subscription"
      }`;

  // Label for the model-source badge. A custom model is a "chat override" when
  // it is scoped to an existing conversation, and a "user override" otherwise
  // (the new-chat case, where it reflects the user's own default).
  const modelSourceLabel =
    modelSource === "agent"
      ? "agent"
      : modelSource === "organization"
        ? "org"
        : conversationId
          ? "chat override"
          : "user override";

  // Any file type can be attached: a file the model can't read is still stored
  // and surfaced in the conversation's Files panel (and staged into the
  // sandbox when one is available), so the only gate is the org-level toggle.
  const showFileUploadButton = allowFileUploads;
  const supportedTypesDescription = executionMode
    ? "files are staged into the isolated execution before the Agent starts"
    : sandboxAvailable
      ? "any file type"
      : "any file type (files this model can't read are saved to the chat's Files panel)";

  // Check if user can update agent settings (to show settings link in tooltip)
  const { data: canUpdateAgentSettings } = useHasPermissions({
    agentSettings: ["update"],
  });

  // LockedChat toggle: only on the new-chat composer (no conversation yet —
  // the same gate InitialAgentSelector uses via its callback prop) and only
  // when the instance has locked chats enabled.
  const lockedChatEnabled = useFeature("lockedChatEnabled") ?? false;
  const { altKey } = usePlatform();
  const showLockedChatToggle =
    !executionMode &&
    lockedChatEnabled &&
    !conversationId &&
    !!onLockedChatChange;

  // Files staged before the toggle survive it: a locked chat stores its
  // attachments sealed under the conversation key, so the first message can
  // carry them just as an unlocked one would.
  const toggleLockedChat = useCallback(() => {
    onLockedChatChange?.(!lockedChat);
  }, [lockedChat, onLockedChatChange]);

  // While the toggle is on screen, Alt+I toggles the draft in place: the
  // global shortcut dispatches this cancelable event before navigating and
  // claiming it (preventDefault) suppresses the navigation — see
  // useConversationSearch.
  useEffect(() => {
    if (!showLockedChatToggle) return;
    const handleShortcut = (event: Event) => {
      event.preventDefault();
      toggleLockedChat();
    };
    window.addEventListener(LOCKED_CHAT_DRAFT_SHORTCUT_EVENT, handleShortcut);
    return () =>
      window.removeEventListener(
        LOCKED_CHAT_DRAFT_SHORTCUT_EVENT,
        handleShortcut,
      );
  }, [showLockedChatToggle, toggleLockedChat]);

  // RBAC: check if user can see agent picker and provider settings in chat
  const { data: canSeeAgentPicker } = useHasPermissions({
    chatAgentPicker: ["enable"],
  });
  const { data: canSeeProviderSettings } = useHasPermissions({
    chatProviderSettings: ["enable"],
  });
  const canShowProviderSettings =
    !executionMode && canSeeProviderSettings === true;

  const handleModelSelectorOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setTimeout(() => {
          textareaRef.current?.focus();
        }, 100);
      }
    },
    [textareaRef],
  );

  return (
    <PromptInputTools ref={toolbarRef} className="gap-0.5">
      {!executionMode &&
        canSeeProviderSettings === false &&
        subscriptionConnectRequired &&
        (conversationId || onApiKeyChange) && (
          <div className="hidden">
            <LlmProviderApiKeySelector
              conversationId={conversationId}
              currentProvider={currentProvider}
              currentConversationChatApiKeyId={
                conversationId
                  ? (currentConversationChatApiKeyId ?? null)
                  : (initialApiKeyId ?? null)
              }
              onApiKeyChange={onApiKeyChange}
              onProviderChange={onProviderChange}
              isModelsLoading={isModelsLoading}
              agentLlmApiKeyId={agentLlmApiKeyId}
              suppressAutoSelect={agentRequiresPerUserConnect}
              connectRequestToken={subscriptionConnectRequest}
            />
          </div>
        )}
      {/* Narrow: vertical three-dots menu for collapsed toolbar items */}
      {isNarrow &&
        (showDefaultLogo &&
        logoProvider &&
        !subscriptionConnectRequired &&
        (modelSource === "agent" || modelSource === "organization") ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2"
            onClick={expandModelSelector}
          >
            <ModelSelectorLogo provider={logoProvider} className="size-4" />
          </Button>
        ) : (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-2"
              >
                <MoreVerticalIcon className="size-4" />
                <span className="sr-only">More options</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-auto p-3">
              <div className="flex flex-col gap-3">
                {canSeeAgentPicker &&
                  selectorAgentId !== undefined &&
                  onAgentChange && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                        Agent
                      </p>
                      <InitialAgentSelector
                        currentAgentId={selectorAgentId}
                        onAgentChange={onAgentChange}
                      />
                    </div>
                  )}
                {canShowProviderSettings && (
                  <>
                    {modelSource && !subscriptionConnectRequired && (
                      <div className="flex items-center gap-1.5">
                        <ComposerBadge>
                          {modelSourceLabel}
                          {modelSource === "user" && onResetModelOverride && (
                            <button
                              type="button"
                              onClick={onResetModelOverride}
                              className="text-muted-foreground hover:text-foreground transition-colors"
                              title="Reset to default"
                            >
                              <XIcon className="size-3" />
                            </button>
                          )}
                        </ComposerBadge>
                      </div>
                    )}
                    {toolsUnavailable && (
                      <div className="flex items-center gap-1.5">
                        <NoToolsModelBadge />
                      </div>
                    )}
                    {(conversationId || onApiKeyChange) && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                          Provider API Key
                        </p>
                        <LlmProviderApiKeySelector
                          conversationId={conversationId}
                          currentProvider={currentProvider}
                          currentConversationChatApiKeyId={
                            conversationId
                              ? (currentConversationChatApiKeyId ?? null)
                              : (initialApiKeyId ?? null)
                          }
                          onApiKeyChange={onApiKeyChange}
                          onProviderChange={onProviderChange}
                          isModelsLoading={isModelsLoading}
                          agentLlmApiKeyId={agentLlmApiKeyId}
                          suppressAutoSelect={agentRequiresPerUserConnect}
                          connectRequestToken={subscriptionConnectRequest}
                        />
                        {subscriptionConnectRequired &&
                          onSubscriptionConnect && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="mt-2 h-7 gap-1.5 px-2 text-xs"
                              onClick={onSubscriptionConnect}
                            >
                              {subscriptionSignInTitle}
                            </Button>
                          )}
                      </div>
                    )}
                    {!subscriptionConnectRequired && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                          Model
                        </p>
                        <ModelSelector
                          selectedModel={selectedModel}
                          onModelChange={onModelChange}
                          apiKeyId={
                            conversationId
                              ? currentConversationChatApiKeyId
                              : initialApiKeyId
                          }
                          suppressAutoSelect={agentRequiresPerUserConnect}
                          fallbackModelName={agentModelDisplayName}
                        />
                        {onThinkingEffortChange && (
                          <ThinkingEffortSelector
                            selectedModel={selectedModel}
                            apiKeyId={
                              conversationId
                                ? currentConversationChatApiKeyId
                                : initialApiKeyId
                            }
                            value={thinkingEffort}
                            onChange={onThinkingEffortChange}
                            className="mt-2 w-fit"
                          />
                        )}
                      </div>
                    )}
                  </>
                )}
                {!executionMode &&
                  canSeeProviderSettings === false &&
                  subscriptionConnectRequired &&
                  onSubscriptionConnect && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={onSubscriptionConnect}
                    >
                      {subscriptionSignInTitle}
                    </Button>
                  )}
                {tokensUsed > 0 && maxContextLength && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                      Context
                    </p>
                    <ContextWindowDialog
                      breakdown={contextWindow ?? null}
                      tokensUsed={tokensUsed}
                      cachedTokens={cachedTokens}
                      maxTokens={maxContextLength}
                      lastCompaction={lastCompaction}
                      onCompact={onCompactConversation}
                      isCompacting={isContextCompacting}
                    >
                      <button
                        type="button"
                        aria-label="Context usage"
                        data-testid={E2eTestId.ChatContextUsageTrigger}
                        className="inline-flex cursor-pointer items-center justify-center rounded-full outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ContextIndicator
                          tokensUsed={tokensUsed}
                          maxTokens={maxContextLength}
                          size="sm"
                        />
                      </button>
                    </ContextWindowDialog>
                  </div>
                )}
              </div>
            </PopoverContent>
          </Popover>
        ))}

      {/* Rendered beside whichever control the collapsed toolbar picked (the
          logo shortcut or the three-dots menu) and outside the RBAC gate: a
          warning that only exists inside a popover — or only for users who can
          see provider settings — is a warning most narrow-viewport users never
          get. The wide toolbar renders its own copy below. */}
      {!executionMode && isNarrow && notRecommendedForAgents && (
        <NotRecommendedForAgentsNoticeBadge />
      )}

      {/* File attachment button - always visible. The org-level toggle greys
          it out with a settings pointer. */}
      {showFileUploadButton ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2"
              onClick={() => attachments.openFileDialog()}
              data-testid={E2eTestId.ChatFileUploadButton}
            >
              <PaperclipIcon className="size-4" />
              <span className="sr-only">Attach files</span>
            </Button>
          </TooltipTrigger>
          {supportedTypesDescription && (
            <TooltipContent side="top" sideOffset={4}>
              Supports: {supportedTypesDescription}
            </TooltipContent>
          )}
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex cursor-pointer"
              data-testid={E2eTestId.ChatDisabledFileUploadButton}
            >
              <PromptInputButton disabled>
                <PaperclipIcon className="size-4" />
              </PromptInputButton>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {canUpdateAgentSettings ? (
              <span>
                File uploads are disabled.{" "}
                <a
                  href="/settings/agents"
                  className="underline hover:no-underline"
                  aria-label="Enable file uploads in Chat settings"
                >
                  Enable in settings
                </a>
              </span>
            ) : (
              <span>File uploads are disabled by your administrator</span>
            )}
          </TooltipContent>
        </Tooltip>
      )}

      {/* LockedChat toggle — placed with the always-visible controls (next to
          the attachment button) so it renders in both the wide and the
          collapsed (narrow) toolbar without duplication. */}
      {showLockedChatToggle && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={lockedChat}
              aria-label="Locked chat"
              data-testid={E2eTestId.LockedChatToggle}
              className={cn(
                "h-8 px-2",
                lockedChat &&
                  "bg-accent text-accent-foreground hover:bg-accent/80",
              )}
              onClick={toggleLockedChat}
            >
              <LockedChatIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            <span className="flex items-center gap-1.5">
              Locked chat <Kbd>{altKey}</Kbd>
              <Kbd>{SHORTCUT_NEW_LOCKED_CHAT.label}</Kbd>
            </span>
          </TooltipContent>
        </Tooltip>
      )}

      {/* Wide: inline toolbar items */}
      {!isNarrow && (
        <>
          {canSeeAgentPicker &&
            selectorAgentId !== undefined &&
            onAgentChange && (
              <InitialAgentSelector
                currentAgentId={selectorAgentId}
                onAgentChange={onAgentChange}
              />
            )}
          {!executionMode &&
            canSeeProviderSettings === false &&
            subscriptionConnectRequired &&
            onSubscriptionConnect && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs text-primary hover:text-primary"
                onClick={onSubscriptionConnect}
              >
                {subscriptionSignInTitle}
              </Button>
            )}
          {!canShowProviderSettings ? null : showDefaultLogo &&
            logoProvider &&
            !subscriptionConnectRequired &&
            (modelSource === "agent" || modelSource === "organization") ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2"
              onClick={expandModelSelector}
            >
              <ModelSelectorLogo provider={logoProvider} className="size-4" />
            </Button>
          ) : (
            /* Same radius as the controls it clips: they are full-height and
               sit flush against the group's end caps, so a wider group radius
               rounds their outer corners while the inner ones keep the button
               radius — a lopsided hover shape (T-1088). */
            <div className="flex items-center h-8 rounded-md bg-muted/50 overflow-hidden">
              {(conversationId || onApiKeyChange) && (
                <LlmProviderApiKeySelector
                  conversationId={conversationId}
                  currentProvider={currentProvider}
                  currentConversationChatApiKeyId={
                    conversationId
                      ? (currentConversationChatApiKeyId ?? null)
                      : (initialApiKeyId ?? null)
                  }
                  onApiKeyChange={onApiKeyChange}
                  onProviderChange={onProviderChange}
                  isModelsLoading={isModelsLoading}
                  agentLlmApiKeyId={agentLlmApiKeyId}
                  suppressAutoSelect={agentRequiresPerUserConnect}
                  connectRequestToken={subscriptionConnectRequest}
                  onOpenChange={(open) => {
                    if (!open) {
                      setTimeout(() => {
                        textareaRef.current?.focus();
                      }, 100);
                    }
                  }}
                />
              )}
              {subscriptionConnectRequired && onSubscriptionConnect && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1 px-2 text-xs text-primary hover:text-primary"
                  onClick={onSubscriptionConnect}
                >
                  {subscriptionSignInTitle}
                </Button>
              )}
              {!subscriptionConnectRequired && (
                <ModelSelector
                  selectedModel={selectedModel}
                  onModelChange={onModelChange}
                  onOpenChange={handleModelSelectorOpenChange}
                  apiKeyId={
                    conversationId
                      ? currentConversationChatApiKeyId
                      : initialApiKeyId
                  }
                  suppressAutoSelect={agentRequiresPerUserConnect}
                  fallbackModelName={agentModelDisplayName}
                />
              )}
              {!subscriptionConnectRequired && onThinkingEffortChange && (
                <ThinkingEffortSelector
                  selectedModel={selectedModel}
                  apiKeyId={
                    conversationId
                      ? currentConversationChatApiKeyId
                      : initialApiKeyId
                  }
                  value={thinkingEffort}
                  onChange={onThinkingEffortChange}
                  className="mr-1"
                />
              )}
              {modelSource && !subscriptionConnectRequired && (
                <ComposerBadge className="ml-1 mr-2">
                  {modelSourceLabel}
                  {modelSource === "user" && onResetModelOverride && (
                    <button
                      type="button"
                      onClick={onResetModelOverride}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      title="Reset to default"
                    >
                      <XIcon className="size-3" />
                    </button>
                  )}
                </ComposerBadge>
              )}
            </div>
          )}
          {!executionMode && toolsUnavailable && <NoToolsModelBadge />}
          {!executionMode && notRecommendedForAgents && (
            <NotRecommendedForAgentsNoticeBadge />
          )}
          {tokensUsed > 0 && maxContextLength && (
            <ContextWindowDialog
              breakdown={contextWindow ?? null}
              tokensUsed={tokensUsed}
              cachedTokens={cachedTokens}
              maxTokens={maxContextLength}
              lastCompaction={lastCompaction}
              onCompact={onCompactConversation}
              isCompacting={isContextCompacting}
            >
              <button
                type="button"
                aria-label="Context usage"
                data-testid={E2eTestId.ChatContextUsageTrigger}
                className="inline-flex cursor-pointer items-center justify-center rounded-full outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ContextIndicator
                  tokensUsed={tokensUsed}
                  maxTokens={maxContextLength}
                  size="sm"
                />
              </button>
            </ContextWindowDialog>
          )}
        </>
      )}

      {/* Apps Hackathon session recorder — a distinct cluster in the composer.
          It records the whole chat (from scratch, even before the first message)
          and opens the replay. Renders nothing when the feature is disabled. */}
      <AppRecordingControls />
    </PromptInputTools>
  );
});

export { ChatPromptInputTools };
