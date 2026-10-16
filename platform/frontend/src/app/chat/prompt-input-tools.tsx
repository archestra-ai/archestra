"use client";

import {
  type ContextWindowBreakdown,
  DocsPage,
  E2eTestId,
  getDocsUrl,
  SUBSCRIPTION_CREDENTIALS,
  type SupportedProvider,
  subscriptionKindForProvider,
  type ThinkingEffortSetting,
} from "@archestra/shared";
import { MoreVerticalIcon, PaperclipIcon } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import {
  PromptInputButton,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { AppRecordingControls } from "@/components/app-session-recording/app-recording-controls";
import { NotRecommendedForAgentsNoticeBadge } from "@/components/chat/agent-recommendation-notice";
import { ChatModelButton } from "@/components/chat/chat-model-button";
import { ChatSetupMenu } from "@/components/chat/chat-setup-menu";
import { ContextIndicator } from "@/components/chat/context-indicator";
import { ContextWindowDialog } from "@/components/chat/context-window-panel";
import { EncryptedChatIcon } from "@/components/chat/encrypted-chat-icon";
import { InitialAgentSelector } from "@/components/chat/initial-agent-selector";
import { LlmProviderApiKeySelector } from "@/components/chat/llm-provider-api-key-selector";
import { NoToolsModelBadge } from "@/components/chat/no-tools-model-notice";
import { ExternalDocsLink } from "@/components/external-docs-link";
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
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  ENCRYPTED_CHAT_DRAFT_SHORTCUT_EVENT,
  SHORTCUT_NEW_ENCRYPTED_CHAT,
} from "@/consts";
import { useHasPermissions } from "@/lib/auth/auth.query";
import type { ModelSource } from "@/lib/chat/use-chat-preferences";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { usePlatform } from "@/lib/hooks/use-platform";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { cn } from "@/lib/utils/tailwind";

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
   * Whether the next chat will be created encrypted-chat. New-chat composer only —
   * the toggle renders only while there is no conversation yet.
   */
  encryptedChat?: boolean;
  /**
   * Provided only by the new-chat composer; together with the
   * `encryptedChatEnabled` feature flag it enables the encrypted-chat toggle.
   */
  onEncryptedChatChange?: (encryptedChat: boolean) => void;
  /** The composer launches an isolated Agent run, not a chat turn. */
  runtimeMode?: boolean;
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
  encryptedChat = false,
  onEncryptedChatChange,
  runtimeMode = false,
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
  const [optionsOpen, setOptionsOpen] = useState(false);
  const providerCatalog = useModelProviderCatalog();
  // New chats expose their setup; existing conversations keep it in one menu.
  const showOptionsMenu = !!conversationId || isNarrow;

  const selectedApiKeyId = conversationId
    ? (currentConversationChatApiKeyId ?? null)
    : (initialApiKeyId ?? null);
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

  // Any file type can be attached: a file the model can't read is still stored
  // and surfaced in the conversation's Files panel (and staged into the
  // sandbox when one is available), so the only gate is the org-level toggle.
  const showFileUploadButton = allowFileUploads;
  const attachHint = runtimeMode
    ? "Attach files for the Agent's runtime"
    : sandboxAvailable
      ? "Attach any file"
      : "Attach any file. Unreadable ones go to Files.";

  // Check if user can update agent settings (to show settings link in tooltip)
  const { data: canUpdateAgentSettings } = useHasPermissions({
    organizationSettings: ["update"],
  });

  // EncryptedChat toggle: only on the new-chat composer (no conversation yet —
  // the same gate InitialAgentSelector uses via its callback prop) and only
  // when the instance has encrypted chats enabled.
  const encryptedChatFeature = useFeature("encryptedChatEnabled");
  const encryptedChatEnabled = encryptedChatFeature ?? false;
  const { altKey } = usePlatform();
  const appName = useAppName();
  const encryptedChatComposer =
    !runtimeMode && !conversationId && !!onEncryptedChatChange;
  const showEncryptedChatToggle = encryptedChatComposer && encryptedChatEnabled;
  // When the instance has not enabled encrypted chats, the lock stays in the
  // same spot as a pointer to the feature: it explains what it does and how an
  // administrator turns it on. Only on an explicit `false`, so it does not
  // flash in place of the real toggle while the config is still loading.
  const showEncryptedChatSetupHint =
    encryptedChatComposer && encryptedChatFeature === false;

  // Files staged before the toggle survive it: an encrypted chat stores its
  // attachments sealed under the conversation key, so the first message can
  // carry them just as an unencrypted one would.
  const toggleEncryptedChat = useCallback(() => {
    onEncryptedChatChange?.(!encryptedChat);
  }, [encryptedChat, onEncryptedChatChange]);

  // While the toggle is on screen, Alt+I toggles the draft in place: the
  // global shortcut dispatches this cancelable event before navigating and
  // claiming it (preventDefault) suppresses the navigation — see
  // useConversationSearch.
  useEffect(() => {
    if (!showEncryptedChatToggle) return;
    const handleShortcut = (event: Event) => {
      event.preventDefault();
      toggleEncryptedChat();
    };
    window.addEventListener(
      ENCRYPTED_CHAT_DRAFT_SHORTCUT_EVENT,
      handleShortcut,
    );
    return () =>
      window.removeEventListener(
        ENCRYPTED_CHAT_DRAFT_SHORTCUT_EVENT,
        handleShortcut,
      );
  }, [showEncryptedChatToggle, toggleEncryptedChat]);

  // RBAC: the full chat view shows the agent picker and provider settings;
  // without it, chat is the simpler view.
  const { data: canSeeFullView } = useHasPermissions({
    chat: ["full-view"],
  });
  const canShowProviderSettings = !runtimeMode && canSeeFullView === true;

  const focusTextarea = useCallback(() => {
    // Popover restores focus to its trigger as it closes. Wait until that
    // finishes before returning focus to the prompt for the user's next input.
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 100);
  }, [textareaRef]);

  const handleAgentChange = useCallback(
    (agentId: string) => {
      onAgentChange?.(agentId);
      focusTextarea();
    },
    [focusTextarea, onAgentChange],
  );

  const closeOptions = useCallback(() => {
    setOptionsOpen(false);
    focusTextarea();
  }, [focusTextarea]);

  const handleSelectorOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        focusTextarea();
      }
    },
    [focusTextarea],
  );

  return (
    <PromptInputTools ref={toolbarRef} className="gap-0.5">
      {/* Not rendered visibly: it owns the key auto-selection and the
          subscription connect/reconnect dialogs. The setup menu lists keys
          itself, and a viewer without provider settings still needs the
          connect flow. */}
      {!runtimeMode &&
        (conversationId || onApiKeyChange) &&
        (canShowProviderSettings ||
          (canSeeFullView === false && subscriptionConnectRequired)) && (
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
      {/* Existing chats always use the menu; new chats use it only when space is tight. */}
      {showOptionsMenu && (
        <Popover open={optionsOpen} onOpenChange={setOptionsOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm">
              <MoreVerticalIcon className="size-4" />
              <span className="sr-only">More options</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            className="w-auto overflow-hidden p-0"
          >
            <ChatSetupMenu
              conversationId={conversationId}
              close={closeOptions}
              agentId={selectorAgentId}
              onAgentChange={
                canSeeFullView && selectorAgentId !== undefined
                  ? handleAgentChange
                  : undefined
              }
              canShowProviderSettings={canShowProviderSettings}
              selectedModel={selectedModel}
              onModelChange={onModelChange}
              fallbackModelName={agentModelDisplayName}
              modelSource={modelSource}
              onResetModelOverride={onResetModelOverride}
              suppressAutoSelect={agentRequiresPerUserConnect}
              apiKeyId={selectedApiKeyId}
              currentProvider={currentProvider}
              canChangeCredential={
                canShowProviderSettings && !!(conversationId || onApiKeyChange)
              }
              onApiKeyChange={onApiKeyChange}
              onProviderChange={onProviderChange}
              subscriptionConnectRequired={subscriptionConnectRequired}
              onSubscriptionConnect={onSubscriptionConnect}
              subscriptionSignInTitle={subscriptionSignInTitle}
              thinkingEffort={thinkingEffort}
              onThinkingEffortChange={onThinkingEffortChange}
              toolsUnavailable={toolsUnavailable}
              notRecommendedForAgents={notRecommendedForAgents}
            />
          </PopoverContent>
        </Popover>
      )}

      {/* Rendered beside the options menu and outside the RBAC gate: a
          warning that only exists inside a popover — or only for users who can
          see provider settings — is a warning most narrow-viewport users never
          get. The wide toolbar renders its own copy below. */}
      {!runtimeMode && showOptionsMenu && notRecommendedForAgents && (
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
              size="icon-sm"
              onClick={() => attachments.openFileDialog()}
              data-testid={E2eTestId.ChatFileUploadButton}
            >
              <PaperclipIcon className="size-4" />
              <span className="sr-only">Attach files</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {attachHint}
          </TooltipContent>
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

      {/* Context usage sits beside the attachment button at every width, so
          it stays one glance away once the setup moves into the menu. */}
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
          <UnstyledButton
            type="button"
            aria-label="Context usage"
            data-testid={E2eTestId.ChatContextUsageTrigger}
            className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ContextIndicator
              tokensUsed={tokensUsed}
              maxTokens={maxContextLength}
              size="sm"
            />
          </UnstyledButton>
        </ContextWindowDialog>
      )}

      {/* EncryptedChat toggle — placed with the always-visible controls (next to
          the attachment button) so it renders in both the wide and the
          collapsed (narrow) toolbar without duplication. */}
      {showEncryptedChatToggle && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-pressed={encryptedChat}
              aria-label="Encrypted chat"
              data-testid={E2eTestId.EncryptedChatToggle}
              className={cn(
                encryptedChat &&
                  "bg-accent text-accent-foreground hover:bg-accent/80",
              )}
              onClick={toggleEncryptedChat}
            >
              <EncryptedChatIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            <span className="flex items-center gap-1.5">
              Encrypted chat <Kbd>{altKey}</Kbd>
              <Kbd>{SHORTCUT_NEW_ENCRYPTED_CHAT.label}</Kbd>
            </span>
          </TooltipContent>
        </Tooltip>
      )}

      {showEncryptedChatSetupHint && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Encrypted chat (not set up)"
              data-testid={E2eTestId.EncryptedChatSetupHint}
              className="text-muted-foreground"
            >
              <EncryptedChatIcon className="size-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            className="w-96 space-y-2 text-sm"
          >
            <p className="font-medium">Encrypted chats</p>
            <p className="text-muted-foreground">
              Some conversations shouldn&apos;t be visible to the team that runs{" "}
              {appName} — for example, sensitive discussions among senior
              management. Yet the company still needs a way to audit them in an
              emergency.
            </p>
            <p className="text-muted-foreground">
              Encrypted chats solve this. Each chat is encrypted with a key kept
              in the user&apos;s browser, and a backup of that key is locked
              with an escrow key held by a trusted group, such as the
              CISO&apos;s office. People can then work with sensitive data with
              more peace of mind.
            </p>
            <p className="text-muted-foreground">
              To turn it on, generate an escrow key pair, hand the private key
              to that group, and set{" "}
              <code className="break-all rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
                ARCHESTRA_ENCRYPTED_CHAT_ESCROW_PUBLIC_KEY
              </code>{" "}
              on the deployment.
            </p>
            <ExternalDocsLink
              href={getDocsUrl(
                DocsPage.PlatformSecurityContentEncryption,
                "key-escrow",
              )}
              className="underline decoration-dotted underline-offset-4 hover:decoration-solid"
            >
              Learn how to enable it
            </ExternalDocsLink>
          </PopoverContent>
        </Popover>
      )}

      {/* Wide: inline toolbar items */}
      {!showOptionsMenu && (
        <>
          {canSeeFullView && selectorAgentId !== undefined && onAgentChange && (
            <InitialAgentSelector
              currentAgentId={selectorAgentId}
              onAgentChange={handleAgentChange}
            />
          )}
          {!runtimeMode &&
            canSeeFullView === false &&
            subscriptionConnectRequired &&
            onSubscriptionConnect && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-primary hover:text-primary"
                onClick={onSubscriptionConnect}
              >
                {subscriptionSignInTitle}
              </Button>
            )}
          {canShowProviderSettings && (
            <ChatModelButton
              onOpenChange={handleSelectorOpenChange}
              conversationId={conversationId}
              agentId={selectorAgentId}
              canShowProviderSettings={canShowProviderSettings}
              selectedModel={selectedModel}
              onModelChange={onModelChange}
              fallbackModelName={agentModelDisplayName}
              modelSource={modelSource}
              onResetModelOverride={onResetModelOverride}
              suppressAutoSelect={agentRequiresPerUserConnect}
              apiKeyId={selectedApiKeyId}
              currentProvider={currentProvider}
              canChangeCredential={
                canShowProviderSettings && !!(conversationId || onApiKeyChange)
              }
              onApiKeyChange={onApiKeyChange}
              onProviderChange={onProviderChange}
              subscriptionConnectRequired={subscriptionConnectRequired}
              onSubscriptionConnect={onSubscriptionConnect}
              subscriptionSignInTitle={subscriptionSignInTitle}
              thinkingEffort={thinkingEffort}
              onThinkingEffortChange={onThinkingEffortChange}
              toolsUnavailable={toolsUnavailable}
              notRecommendedForAgents={notRecommendedForAgents}
            />
          )}
          {!runtimeMode && toolsUnavailable && <NoToolsModelBadge />}
          {!runtimeMode && notRecommendedForAgents && (
            <NotRecommendedForAgentsNoticeBadge />
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
