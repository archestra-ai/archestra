"use client";

import {
  E2eTestId,
  getAcceptedFileTypes,
  getSupportedFileTypesDescription,
  type ModelInputModality,
  type SupportedProvider,
  supportsFileUploads,
} from "@shared";
import type { ChatStatus } from "ai";
import { MoreVerticalIcon, PaperclipIcon, RotateCcwIcon } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef } from "react";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputProvider,
  PromptInputSpeechButton,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import { ChatApiKeySelector } from "@/components/chat/chat-api-key-selector";
import { ContextIndicator } from "@/components/chat/context-indicator";
import { InitialAgentSelector } from "@/components/chat/initial-agent-selector";
import { KnowledgeBaseUploadIndicator } from "@/components/chat/knowledge-base-upload-indicator";
import {
  ModelSelector,
  providerToLogoProvider,
} from "@/components/chat/model-selector";
import { PlaywrightInstallInline } from "@/components/chat/playwright-install-dialog";
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
import { useProfile } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth.query";
import { useChatPlaceholder } from "@/lib/chat-placeholder.hook";
import { conversationStorageKeys } from "@/lib/chat-utils";
import { useOrganization } from "@/lib/organization.query";
import type { ModelSource } from "@/lib/use-chat-preferences";
import { useIsMobile } from "@/lib/use-mobile.hook";
import { useModelSelectorDisplay } from "@/lib/use-model-selector-display.hook";

interface ArchestraPromptInputProps {
  onSubmit: (
    message: PromptInputMessage,
    e: FormEvent<HTMLFormElement>,
  ) => void;
  status: ChatStatus;
  selectedModel: string;
  onModelChange: (model: string) => void;
  messageCount?: number;
  // Tools integration props
  agentId: string;
  /** Optional - if not provided, it's initial chat mode (no conversation yet) */
  conversationId?: string;
  // API key selector props
  currentConversationChatApiKeyId?: string | null;
  currentProvider?: SupportedProvider;
  /** Selected API key ID for initial chat mode */
  initialApiKeyId?: string | null;
  /** Callback for API key change in initial chat mode (no conversation) */
  onApiKeyChange?: (apiKeyId: string) => void;
  /** Callback when user selects an API key with a different provider */
  onProviderChange?: (provider: SupportedProvider, apiKeyId: string) => void;
  // Ref for autofocus
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Whether file uploads are allowed (controlled by organization setting) */
  allowFileUploads?: boolean;
  /** Whether models are still loading - passed to API key selector */
  isModelsLoading?: boolean;
  /** Estimated tokens used in the conversation (for context indicator) */
  tokensUsed?: number;
  /** Maximum context length of the selected model (for context indicator) */
  maxContextLength?: number | null;
  /** Input modalities supported by the selected model (for file type filtering) */
  inputModalities?: ModelInputModality[] | null;
  /** Agent's configured LLM API key ID - passed to ChatApiKeySelector */
  agentLlmApiKeyId?: string | null;
  /** Disable the submit button (e.g., when Playwright setup overlay is visible) */
  submitDisabled?: boolean;
  /** Whether Playwright setup overlay is visible (for showing Playwright install dialog) */
  isPlaywrightSetupVisible: boolean;
  /** Current agent ID for agent selector */
  selectorAgentId?: string | null;
  /** Callback when agent changes */
  onAgentChange?: (agentId: string) => void;
  /** Callback when model selector opens/closes */
  onModelSelectorOpenChange?: (open: boolean) => void;
  /** Source of the currently selected model (agent, organization, user, or null for fallback) */
  modelSource?: ModelSource | null;
  /** Callback to reset user model override back to agent/org default */
  onResetModelOverride?: () => void;
}

// Inner component that has access to the controller context
const PromptInputContent = ({
  onSubmit,
  status,
  selectedModel,
  onModelChange,
  messageCount,
  agentId,
  conversationId,
  currentConversationChatApiKeyId,
  currentProvider,
  initialApiKeyId,
  onApiKeyChange,
  onProviderChange,
  textareaRef: externalTextareaRef,
  allowFileUploads = false,
  isModelsLoading = false,
  tokensUsed = 0,
  maxContextLength,
  inputModalities,
  agentLlmApiKeyId,
  submitDisabled = false,
  isPlaywrightSetupVisible = false,
  selectorAgentId,
  onAgentChange,
  onModelSelectorOpenChange,
  modelSource,
  onResetModelOverride,
}: Omit<ArchestraPromptInputProps, "onSubmit"> & {
  onSubmit: ArchestraPromptInputProps["onSubmit"];
}) => {
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalTextareaRef ?? internalTextareaRef;
  const controller = usePromptInputController();
  const attachments = usePromptInputAttachments();

  // Collapsed/expanded state for the model selector (defaults to collapsed = provider icon only)
  const { isCollapsed: showDefaultLogo, expand: expandModelSelector } =
    useModelSelectorDisplay({ conversationId });

  const logoProvider = currentProvider
    ? providerToLogoProvider[currentProvider]
    : null;

  // Derive file upload capabilities from model input modalities
  const modelSupportsFiles = supportsFileUploads(inputModalities);
  const acceptedFileTypes = getAcceptedFileTypes(inputModalities);
  const supportedTypesDescription =
    getSupportedFileTypesDescription(inputModalities);

  // Check if agent has a knowledge base
  const { data: agentData } = useProfile(agentId);

  // Check if user can update agent settings (to show settings link in tooltip)
  const { data: canUpdateAgentSettings } = useHasPermissions({
    agentSettings: ["update"],
  });

  // Chat placeholders from organization settings
  const { data: orgData } = useOrganization();
  const { placeholder: chatPlaceholder } = useChatPlaceholder({
    animate: orgData?.animateChatPlaceholders ?? true,
    placeholders: orgData?.chatPlaceholders,
  });

  // RBAC: check if user can see agent picker and provider settings in chat
  const { data: canSeeAgentPicker } = useHasPermissions({
    chatAgentPicker: ["enable"],
  });
  const { data: canSeeProviderSettings } = useHasPermissions({
    chatProviderSettings: ["enable"],
  });

  const storageKey = conversationId
    ? conversationStorageKeys(conversationId).draft
    : `archestra_chat_draft_new_${agentId}`;

  const isRestored = useRef(false);

  // Restore draft on mount or conversation change
  // biome-ignore lint/correctness/useExhaustiveDependencies: controller.textInput is a new object every render (recreated in useMemo when textInput state changes), so using it as a dependency causes the effect to fire on every keystroke, clearing the input. Use the stable setInput function reference instead.
  useEffect(() => {
    isRestored.current = false;
    const savedDraft = localStorage.getItem(storageKey);
    if (savedDraft) {
      controller.textInput.setInput(savedDraft);
    } else {
      controller.textInput.setInput("");
    }

    // Set restored bit after a tick to ensure state update propagates
    const timeout = setTimeout(() => {
      isRestored.current = true;
    }, 0);
    return () => clearTimeout(timeout);
  }, [storageKey, controller.textInput.setInput]);

  // Save draft on change
  useEffect(() => {
    if (!isRestored.current) return;

    const value = controller.textInput.value;
    if (value) {
      localStorage.setItem(storageKey, value);
    } else {
      localStorage.removeItem(storageKey);
    }
  }, [controller.textInput.value, storageKey]);

  // Handle speech transcription by updating controller state
  const handleTranscriptionChange = useCallback(
    (text: string) => {
      controller.textInput.setInput(text);
    },
    [controller.textInput],
  );

  const knowledgeBaseIds =
    ((agentData as Record<string, unknown> | null | undefined)
      ?.knowledgeBaseIds as string[] | undefined) ?? [];
  const connectorIds =
    ((agentData as Record<string, unknown> | null | undefined)?.connectorIds as
      | string[]
      | undefined) ?? [];
  const hasKnowledgeSources =
    knowledgeBaseIds.length > 0 || connectorIds.length > 0;

  const isMobile = useIsMobile();

  // Determine if file uploads should be shown
  // 1. Organization must allow file uploads (allowFileUploads)
  // 2. Model must support at least one file type (modelSupportsFiles)
  const showFileUploadButton = allowFileUploads && modelSupportsFiles;

  const handleWrappedSubmit = useCallback(
    (message: PromptInputMessage, e: FormEvent<HTMLFormElement>) => {
      localStorage.removeItem(storageKey);
      onSubmit(message, e);
    },
    [onSubmit, storageKey],
  );

  return (
    <PromptInput
      globalDrop
      multiple
      onSubmit={handleWrappedSubmit}
      accept={acceptedFileTypes}
    >
      {/* File attachments display - shown inline above textarea */}
      <PromptInputAttachments className="px-3 pt-2 pb-0">
        {(attachment) => <PromptInputAttachment data={attachment} />}
      </PromptInputAttachments>
      <PromptInputBody>
        {isPlaywrightSetupVisible && conversationId ? (
          <PlaywrightInstallInline
            agentId={agentId}
            conversationId={conversationId}
          />
        ) : (
          <PromptInputTextarea
            placeholder={
              conversationId
                ? "Ask a follow-up..."
                : (chatPlaceholder ?? "What would you like to get done?")
            }
            ref={textareaRef}
            className="px-4"
            autoFocus
            disabled={submitDisabled}
            disableEnterSubmit={status !== "ready" && status !== "error"}
            data-testid={E2eTestId.ChatPromptTextarea}
          />
        )}
      </PromptInputBody>
      <PromptInputFooter>
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
                            <p className="text-xs font-medium text-muted-foreground">
                              {modelSource === "agent"
                                ? "Agent default"
                                : modelSource === "organization"
                                  ? "Org default"
                                  : "User override"}
                            </p>
                            {modelSource === "user" && onResetModelOverride && (
                              <button
                                type="button"
                                onClick={onResetModelOverride}
                                className="text-muted-foreground hover:text-foreground transition-colors"
                                title="Reset to default"
                              >
                                <RotateCcwIcon className="size-3" />
                              </button>
                            )}
                          </div>
                        )}
                        {(conversationId || onApiKeyChange) && (
                          <div>
                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                              Provider API Key
                            </p>
                            <ChatApiKeySelector
                              conversationId={conversationId}
                              currentProvider={currentProvider}
                              currentConversationChatApiKeyId={
                                conversationId
                                  ? (currentConversationChatApiKeyId ?? null)
                                  : (initialApiKeyId ?? null)
                              }
                              messageCount={messageCount}
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
                            onOpenChange={onModelSelectorOpenChange}
                            apiKeyId={
                              conversationId
                                ? currentConversationChatApiKeyId
                                : initialApiKeyId
                            }
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
                  <ModelSelectorLogo
                    provider={logoProvider}
                    className="size-4"
                  />
                </Button>
              ) : (
                <div className="flex items-center h-8 rounded-full border border-border bg-muted/50 overflow-hidden">
                  {(conversationId || onApiKeyChange) && (
                    <ChatApiKeySelector
                      conversationId={conversationId}
                      currentProvider={currentProvider}
                      currentConversationChatApiKeyId={
                        conversationId
                          ? (currentConversationChatApiKeyId ?? null)
                          : (initialApiKeyId ?? null)
                      }
                      messageCount={messageCount}
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
                    onOpenChange={(open) => {
                      onModelSelectorOpenChange?.(open);
                      if (!open) {
                        setTimeout(() => {
                          textareaRef.current?.focus();
                        }, 100);
                      }
                    }}
                    apiKeyId={
                      conversationId
                        ? currentConversationChatApiKeyId
                        : initialApiKeyId
                    }
                  />
                  {modelSource && (
                    <span className="pr-2.5 pl-0.5 text-xs text-muted-foreground whitespace-nowrap inline-flex items-center gap-1">
                      {"("}
                      {modelSource === "agent"
                        ? "agent"
                        : modelSource === "organization"
                          ? "org"
                          : "user override"}
                      {modelSource === "user" && onResetModelOverride && (
                        <button
                          type="button"
                          onClick={onResetModelOverride}
                          className="ml-0.5 text-muted-foreground hover:text-foreground transition-colors"
                          title="Reset to default"
                        >
                          <RotateCcwIcon className="size-3" />
                        </button>
                      )}
                      {")"}
                    </span>
                  )}
                </div>
              )}
              {tokensUsed > 0 && maxContextLength && (
                <ContextIndicator
                  tokensUsed={tokensUsed}
                  maxTokens={maxContextLength}
                  size="sm"
                />
              )}
            </>
          )}
        </PromptInputTools>
        <div className="flex items-center gap-2">
          <KnowledgeBaseUploadIndicator
            attachmentCount={controller.attachments.files.length}
            hasKnowledgeBase={hasKnowledgeSources}
          />
          <PromptInputSpeechButton
            textareaRef={textareaRef}
            onTranscriptionChange={handleTranscriptionChange}
          />
          <PromptInputSubmit
            className="!h-8"
            status={status}
            disabled={submitDisabled}
          />
        </div>
      </PromptInputFooter>
    </PromptInput>
  );
};

const ArchestraPromptInput = ({
  onSubmit,
  status,
  selectedModel,
  onModelChange,
  messageCount = 0,
  agentId,
  conversationId,
  currentConversationChatApiKeyId,
  currentProvider,
  initialApiKeyId,
  onApiKeyChange,
  onProviderChange,
  textareaRef,
  allowFileUploads = false,
  isModelsLoading = false,
  tokensUsed = 0,
  maxContextLength,
  inputModalities,
  agentLlmApiKeyId,
  submitDisabled,
  isPlaywrightSetupVisible,
  selectorAgentId,
  onAgentChange,
  onModelSelectorOpenChange,
  modelSource,
  onResetModelOverride,
}: ArchestraPromptInputProps) => {
  return (
    <div className="flex size-full flex-col justify-end">
      <PromptInputProvider>
        <PromptInputContent
          onSubmit={onSubmit}
          status={status}
          selectedModel={selectedModel}
          onModelChange={onModelChange}
          messageCount={messageCount}
          agentId={agentId}
          conversationId={conversationId}
          currentConversationChatApiKeyId={currentConversationChatApiKeyId}
          currentProvider={currentProvider}
          initialApiKeyId={initialApiKeyId}
          onApiKeyChange={onApiKeyChange}
          onProviderChange={onProviderChange}
          textareaRef={textareaRef}
          allowFileUploads={allowFileUploads}
          isModelsLoading={isModelsLoading}
          tokensUsed={tokensUsed}
          maxContextLength={maxContextLength}
          inputModalities={inputModalities}
          agentLlmApiKeyId={agentLlmApiKeyId}
          submitDisabled={submitDisabled}
          isPlaywrightSetupVisible={isPlaywrightSetupVisible}
          selectorAgentId={selectorAgentId}
          onAgentChange={onAgentChange}
          onModelSelectorOpenChange={onModelSelectorOpenChange}
          modelSource={modelSource}
          onResetModelOverride={onResetModelOverride}
        />
      </PromptInputProvider>
    </div>
  );
};

export default ArchestraPromptInput;
