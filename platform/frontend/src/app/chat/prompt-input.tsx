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
import { MoreVerticalIcon, PaperclipIcon, XIcon } from "lucide-react";
import { nanoid } from "nanoid";
import type { FormEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputButton,
  PromptInputCommand,
  PromptInputCommandEmpty,
  PromptInputCommandGroup,
  PromptInputCommandItem,
  PromptInputCommandList,
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
import { ContextIndicator } from "@/components/chat/context-indicator";
import { InitialAgentSelector } from "@/components/chat/initial-agent-selector";
import { KnowledgeBaseUploadIndicator } from "@/components/chat/knowledge-base-upload-indicator";
import { LlmProviderApiKeySelector } from "@/components/chat/llm-provider-api-key-selector";
import {
  ModelSelector,
  providerToLogoProvider,
} from "@/components/chat/model-selector";
import { PlaywrightInstallInline } from "@/components/chat/playwright-install-dialog";
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
import { useProfile } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useChatPlaceholder } from "@/lib/chat/chat-placeholder.hook";
import { conversationStorageKeys } from "@/lib/chat/chat-utils";
import type { ModelSource } from "@/lib/chat/use-chat-preferences";
import { useModelSelectorDisplay } from "@/lib/chat/use-model-selector-display.hook";
import { useIsMobile } from "@/lib/hooks/use-mobile";
import { useOrganization } from "@/lib/organization.query";
import { cn } from "@/lib/utils";
import {
  PromptInputQueue,
  type QueuedPromptInputMessage,
} from "./prompt-input-queue";

interface ArchestraPromptInputProps {
  onSubmit: (
    message: PromptInputMessage,
    e: FormEvent<HTMLFormElement>,
  ) => void;
  status: ChatStatus;
  selectedModel: string;
  onModelChange: (model: string) => void;
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
  /** Agent's configured LLM API key ID - passed to LlmProviderApiKeySelector */
  agentLlmApiKeyId?: string | null;
  /** Disable the submit button (e.g., when Playwright setup overlay is visible) */
  submitDisabled?: boolean;
  /** Disable chat input while context compaction is running */
  isContextCompacting?: boolean;
  /** Manually compact the active conversation */
  onCompactConversation?: () => Promise<void> | void;
  /** Whether Playwright setup overlay is visible (for showing Playwright install dialog) */
  isPlaywrightSetupVisible: boolean;
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
}

type SlashCommand = {
  value: string;
  name: string;
  description: string;
};

const SLASH_COMMANDS: SlashCommand[] = [
  {
    value: "/compact",
    name: "compact",
    description: "summarize conversation to prevent hitting the context limit",
  },
];

// Inner component that has access to the controller context
const PromptInputContent = ({
  onSubmit,
  status,
  selectedModel,
  onModelChange,
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
  isContextCompacting = false,
  onCompactConversation,
  isPlaywrightSetupVisible = false,
  selectorAgentId,
  selectorAgentName,
  onAgentChange,
  modelSource,
  onResetModelOverride,
}: Omit<ArchestraPromptInputProps, "onSubmit"> & {
  onSubmit: ArchestraPromptInputProps["onSubmit"];
}) => {
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalTextareaRef ?? internalTextareaRef;
  const controller = usePromptInputController();
  const attachments = usePromptInputAttachments();
  const commandItemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [dismissedSlashCommandValue, setDismissedSlashCommandValue] = useState<
    string | null
  >(null);
  const [queuedMessages, setQueuedMessages] = useState<
    QueuedPromptInputMessage[]
  >([]);
  const isSendingQueuedMessageRef = useRef(false);

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
  const queueScopeKey = conversationId
    ? `conversation:${conversationId}`
    : `new:${agentId}`;
  const visibleQueuedMessages = useMemo(
    () =>
      queuedMessages.filter((message) => message.scopeKey === queueScopeKey),
    [queuedMessages, queueScopeKey],
  );

  const isRestored = useRef(false);

  // Restore draft on mount or conversation change
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
  const isSlashCommandOpen =
    !!conversationId &&
    !!onCompactConversation &&
    controller.textInput.value.startsWith("/") &&
    controller.textInput.value !== dismissedSlashCommandValue;

  // reset the Escape dismissal once the user edits the input — typing more
  // produces a new query and the picker should re-open
  useEffect(() => {
    if (
      dismissedSlashCommandValue !== null &&
      controller.textInput.value !== dismissedSlashCommandValue
    ) {
      setDismissedSlashCommandValue(null);
    }
  }, [controller.textInput.value, dismissedSlashCommandValue]);
  const visibleSlashCommands = useMemo(() => {
    if (!isSlashCommandOpen) {
      return [];
    }

    const query = controller.textInput.value.trim().toLowerCase();
    if (query === "/") {
      return SLASH_COMMANDS;
    }

    return SLASH_COMMANDS.filter((command) => command.value.startsWith(query));
  }, [controller.textInput.value, isSlashCommandOpen]);

  const selectedCommandIndex =
    visibleSlashCommands.length === 0
      ? 0
      : Math.max(
          0,
          Math.min(activeCommandIndex, visibleSlashCommands.length - 1),
        );

  useEffect(() => {
    if (isSlashCommandOpen) {
      setActiveCommandIndex(0);
    }
  }, [isSlashCommandOpen]);

  useEffect(() => {
    commandItemRefs.current[selectedCommandIndex]?.scrollIntoView({
      block: "nearest",
    });
  }, [selectedCommandIndex]);

  const runCompactCommand = useCallback(() => {
    controller.textInput.clear();
    localStorage.removeItem(storageKey);
    void onCompactConversation?.();
  }, [controller.textInput, onCompactConversation, storageKey]);

  const submitQueuedMessage = useCallback(
    (message: QueuedPromptInputMessage) => {
      localStorage.removeItem(storageKey);
      onSubmit({ text: message.text, files: message.files }, {
        preventDefault: () => {},
      } as FormEvent<HTMLFormElement>);
    },
    [onSubmit, storageKey],
  );

  useEffect(() => {
    isSendingQueuedMessageRef.current = false;
    setQueuedMessages((current) =>
      current.filter((message) => message.scopeKey === queueScopeKey),
    );
  }, [queueScopeKey]);

  useEffect(() => {
    if (status !== "ready") {
      isSendingQueuedMessageRef.current = false;
      return;
    }

    if (visibleQueuedMessages.length === 0) {
      return;
    }
    if (isSendingQueuedMessageRef.current) {
      return;
    }

    const [nextMessage] = visibleQueuedMessages;
    isSendingQueuedMessageRef.current = true;
    setQueuedMessages((current) =>
      current.filter((message) => message.id !== nextMessage.id),
    );
    try {
      submitQueuedMessage(nextMessage);
    } catch {
      // restore the message so a failed send is not lost silently; the
      // sending guard stays set so we do not retry in a tight loop — the
      // next ready transition (guard reset on status change) picks it up
      setQueuedMessages((current) => [nextMessage, ...current]);
    }
  }, [visibleQueuedMessages, status, submitQueuedMessage]);

  const selectSlashCommand = useCallback(
    (command: SlashCommand) => {
      if (command.value === "/compact") {
        runCompactCommand();
      }
    },
    [runCompactCommand],
  );

  const handleTextareaKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!isSlashCommandOpen || visibleSlashCommands.length === 0) {
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveCommandIndex(
          (current) => (current + 1) % visibleSlashCommands.length,
        );
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveCommandIndex(
          (current) =>
            (current - 1 + visibleSlashCommands.length) %
            visibleSlashCommands.length,
        );
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const command = visibleSlashCommands[selectedCommandIndex];
        if (command) {
          selectSlashCommand(command);
        }
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedSlashCommandValue(controller.textInput.value);
      }
    },
    [
      controller.textInput.value,
      isSlashCommandOpen,
      selectSlashCommand,
      selectedCommandIndex,
      visibleSlashCommands,
    ],
  );

  const handleWrappedSubmit = useCallback(
    (message: PromptInputMessage, e: FormEvent<HTMLFormElement>) => {
      const hasContent =
        message.text.trim().length > 0 || message.files.length > 0;

      // empty Enter during streaming would otherwise reach onSubmit; the
      // textarea no longer blocks Enter so the parent must rely on this guard
      if (!hasContent) {
        e.preventDefault();
        return;
      }

      if (message.text.trim() === "/compact" && onCompactConversation) {
        e.preventDefault();
        runCompactCommand();
        return;
      }

      if (status === "submitted" || status === "streaming") {
        setQueuedMessages((current) => [
          ...current,
          {
            id: nanoid(),
            scopeKey: queueScopeKey,
            text: message.text,
            files: message.files,
          },
        ]);
        return;
      }

      localStorage.removeItem(storageKey);
      onSubmit(message, e);
    },
    [
      onSubmit,
      onCompactConversation,
      queueScopeKey,
      runCompactCommand,
      status,
      storageKey,
    ],
  );

  const removeQueuedMessage = useCallback((id: string) => {
    setQueuedMessages((current) =>
      current.filter((message) => message.id !== id),
    );
  }, []);

  const handleFileError = useCallback(
    (err: {
      code: "max_files" | "max_file_size" | "accept";
      message: string;
    }) => {
      if (err.code === "accept") {
        toast.error(
          !showFileUploadButton
            ? "This model does not support file uploads"
            : "File format is not supported by this model",
        );
      }
    },
    [showFileUploadButton],
  );
  const submitStatus = status === "error" ? "ready" : status;

  return (
    <div className="relative">
      <PromptInputQueue
        className="absolute inset-x-0 bottom-full z-40"
        messages={visibleQueuedMessages}
        onRemove={removeQueuedMessage}
      />
      {isSlashCommandOpen && (
        <div className="absolute inset-x-0 bottom-full z-50 mb-2 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg">
          <PromptInputCommand className="h-auto rounded-none bg-transparent">
            <PromptInputCommandList className="max-h-64">
              <PromptInputCommandEmpty>
                No commands found.
              </PromptInputCommandEmpty>
              <PromptInputCommandGroup className="p-1">
                {visibleSlashCommands.map((command, index) => (
                  <PromptInputCommandItem
                    key={command.value}
                    value={command.value}
                    ref={(node) => {
                      commandItemRefs.current[index] = node;
                    }}
                    onMouseEnter={() => setActiveCommandIndex(index)}
                    onSelect={() => selectSlashCommand(command)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2.5",
                      index === selectedCommandIndex &&
                        "bg-accent text-accent-foreground",
                    )}
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="mt-0.5 font-mono text-sm text-muted-foreground">
                        /
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-medium">
                          {command.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {command.description}
                        </div>
                      </div>
                    </div>
                    {isContextCompacting && (
                      <span className="text-xs text-muted-foreground">
                        Running
                      </span>
                    )}
                  </PromptInputCommandItem>
                ))}
              </PromptInputCommandGroup>
            </PromptInputCommandList>
          </PromptInputCommand>
        </div>
      )}
      <PromptInput
        globalDrop
        multiple
        onSubmit={handleWrappedSubmit}
        accept={
          showFileUploadButton ? acceptedFileTypes : "application/x-empty"
        }
        onError={handleFileError}
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
              disabled={submitDisabled || isContextCompacting}
              disableEnterSubmit={false}
              onKeyDown={handleTextareaKeyDown}
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
                  <ModelSelectorLogo
                    provider={logoProvider}
                    className="size-4"
                  />
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
                  <PopoverContent
                    side="top"
                    align="start"
                    className="w-auto p-3"
                  >
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
                                {modelSource === "user" &&
                                  onResetModelOverride && (
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
                      currentAgentName={selectorAgentName}
                      onAgentChange={onAgentChange}
                    />
                  )}
                {!canSeeProviderSettings ? null : showDefaultLogo &&
                  logoProvider &&
                  (modelSource === "agent" ||
                    modelSource === "organization") ? (
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
                      onOpenChange={(open) => {
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
              status={submitStatus}
              disabled={submitDisabled || isContextCompacting}
            />
          </div>
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
};

const ArchestraPromptInput = ({
  onSubmit,
  status,
  selectedModel,
  onModelChange,
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
  isContextCompacting,
  onCompactConversation,
  isPlaywrightSetupVisible,
  selectorAgentId,
  selectorAgentName,
  onAgentChange,
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
          isContextCompacting={isContextCompacting}
          onCompactConversation={onCompactConversation}
          isPlaywrightSetupVisible={isPlaywrightSetupVisible}
          selectorAgentId={selectorAgentId}
          selectorAgentName={selectorAgentName}
          onAgentChange={onAgentChange}
          modelSource={modelSource}
          onResetModelOverride={onResetModelOverride}
        />
      </PromptInputProvider>
    </div>
  );
};

export default ArchestraPromptInput;
