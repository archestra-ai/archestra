"use client";

import {
  E2eTestId,
  getSupportedFileTypesDescription,
  type ModelInputModality,
  type SupportedProvider,
  supportsFileUploads,
} from "@archestra/shared";
import { MoreVerticalIcon, PaperclipIcon, XIcon } from "lucide-react";
import { memo, useCallback } from "react";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import {
  PromptInputButton,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { ContextIndicator } from "@/components/chat/context-indicator";
import { InitialAgentSelector } from "@/components/chat/initial-agent-selector";
import { LlmProviderApiKeySelector } from "@/components/chat/llm-provider-api-key-selector";
import {
  ModelSelector,
  providerToLogoProvider,
} from "@/components/chat/model-selector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { useHasPermissions } from "@/lib/auth/auth.query";
import type { ModelSource } from "@/lib/chat/use-chat-preferences";
import { useModelSelectorDisplay } from "@/lib/chat/use-model-selector-display.hook";
import { useIsMobile } from "@/lib/hooks/use-mobile";

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
  /** Whether models are still loading - passed to API key selector */
  isModelsLoading?: boolean;
  /** Estimated tokens used in the conversation (for context indicator) */
  tokensUsed?: number;
  /** Input tokens served from the prompt cache on the latest response (for context indicator) */
  cachedTokens?: number;
  /** Maximum context length of the selected model (for context indicator) */
  maxContextLength?: number | null;
  /** Input modalities supported by the selected model (for file type filtering) */
  inputModalities?: ModelInputModality[] | null;
  /** Agent's configured LLM API key ID - passed to LlmProviderApiKeySelector */
  agentLlmApiKeyId?: string | null;
  /** Current agent ID for agent selector */
  selectorAgentId?: string | null;
  /** Fallback display name when the selected agent is not yet present in the cached agent list */
  selectorAgentName?: string;
  /** Callback when agent changes */
  onAgentChange?: (agentId: string) => void;
  /** Source of the currently selected model (agent, organization, user, or null) */
  modelSource?: ModelSource | null;
  /** Callback to reset user model override back to agent/org default */
  onResetModelOverride?: () => void;
  /**
   * The selected agent pins a per-user-credential model (e.g. GitHub Copilot)
   * the viewer hasn't connected. Keep the agent's model selected (no auto-swap)
   * so sending surfaces an inline connect prompt instead of silently switching.
   */
  agentRequiresPerUserConnect?: boolean;
  /**
   * Server-resolved model name to show in the read-only chip when the agent's
   * per-user model isn't in the viewer's available models (avoids a raw UUID).
   */
  agentModelDisplayName?: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
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
  isModelsLoading = false,
  tokensUsed = 0,
  cachedTokens,
  maxContextLength,
  inputModalities,
  agentLlmApiKeyId,
  selectorAgentId,
  selectorAgentName,
  onAgentChange,
  modelSource,
  onResetModelOverride,
  agentRequiresPerUserConnect = false,
  agentModelDisplayName,
  textareaRef,
}: ChatPromptInputToolsProps) {
  const attachments = usePromptInputAttachments();
  const isMobile = useIsMobile();

  // Collapsed/expanded state for the model selector (defaults to collapsed = provider icon only)
  const { isCollapsed: showDefaultLogo, expand: expandModelSelector } =
    useModelSelectorDisplay({ conversationId });

  const logoProvider = currentProvider
    ? providerToLogoProvider[currentProvider]
    : null;

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

  // Determine if file uploads should be shown
  // 1. Organization must allow file uploads (allowFileUploads)
  // 2. Model must support at least one file type (modelSupportsFiles)
  const showFileUploadButton =
    allowFileUploads && supportsFileUploads(inputModalities);
  const supportedTypesDescription =
    getSupportedFileTypesDescription(inputModalities);

  // Check if user can update agent settings (to show settings link in tooltip)
  const { data: canUpdateAgentSettings } = useHasPermissions({
    agentSettings: ["update"],
  });

  // RBAC: check if user can see agent picker and provider settings in chat
  const { data: canSeeAgentPicker } = useHasPermissions({
    chatAgentPicker: ["enable"],
  });
  const { data: canSeeProviderSettings } = useHasPermissions({
    chatProviderSettings: ["enable"],
  });

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
    <PromptInputTools className="gap-0.5">
      {/* Mobile: vertical three-dots menu for collapsed toolbar items */}
      {isMobile &&
        (showDefaultLogo &&
        logoProvider &&
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
                {canSeeProviderSettings && (
                  <>
                    {modelSource && (
                      <div className="flex items-center gap-1.5">
                        <Badge
                          variant="secondary"
                          className="gap-1 bg-slate-200/70 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300 px-3 py-1 text-xs font-medium"
                        >
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
                        </Badge>
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
                        />
                      </div>
                    )}
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
                    </div>
                  </>
                )}
                {tokensUsed > 0 && maxContextLength && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                      Context
                    </p>
                    <ContextIndicator
                      tokensUsed={tokensUsed}
                      cachedTokens={cachedTokens}
                      maxTokens={maxContextLength}
                      size="sm"
                    />
                  </div>
                )}
              </div>
            </PopoverContent>
          </Popover>
        ))}

      {/* File attachment button - always visible */}
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
            {!allowFileUploads ? (
              canUpdateAgentSettings ? (
                <span>
                  File uploads are disabled.{" "}
                  <a
                    href="/settings/agents"
                    className="underline hover:no-underline"
                    aria-label="Enable file uploads in agent settings"
                  >
                    Enable in settings
                  </a>
                </span>
              ) : (
                "File uploads are disabled by your administrator"
              )
            ) : (
              "This model does not support file uploads"
            )}
          </TooltipContent>
        </Tooltip>
      )}

      {/* Desktop: inline toolbar items */}
      {!isMobile && (
        <>
          {canSeeAgentPicker &&
            selectorAgentId !== undefined &&
            onAgentChange && (
              <InitialAgentSelector
                currentAgentId={selectorAgentId}
                currentAgentName={selectorAgentName}
                onAgentChange={onAgentChange}
              />
            )}
          {!canSeeProviderSettings ? null : showDefaultLogo &&
            logoProvider &&
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
            <div className="flex items-center h-8 rounded-full border border-border bg-muted/50 overflow-hidden">
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
                  onOpenChange={(open) => {
                    if (!open) {
                      setTimeout(() => {
                        textareaRef.current?.focus();
                      }, 100);
                    }
                  }}
                />
              )}
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
              {modelSource && (
                <Badge
                  variant="secondary"
                  className="ml-1 mr-2 gap-1 bg-slate-200/70 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300 px-3 py-1 text-xs font-medium"
                >
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
                </Badge>
              )}
            </div>
          )}
          {tokensUsed > 0 && maxContextLength && (
            <ContextIndicator
              tokensUsed={tokensUsed}
              cachedTokens={cachedTokens}
              maxTokens={maxContextLength}
              size="sm"
            />
          )}
        </>
      )}
    </PromptInputTools>
  );
});

export { ChatPromptInputTools };
