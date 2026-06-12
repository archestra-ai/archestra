"use client";

import {
  type ChatSkillMetadata,
  E2eTestId,
  getAcceptedFileTypes,
  supportsFileUploads,
} from "@archestra/shared";
import type { ChatStatus } from "ai";
import type { FormEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
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
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import { PlaywrightInstallInline } from "@/components/chat/playwright-install-dialog";
import { SensitiveDataConfirmDialog } from "@/components/chat/sensitive-data-confirm-dialog";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useConversation, useToggleHooksDebug } from "@/lib/chat/chat.query";
import { useChatPlaceholder } from "@/lib/chat/chat-placeholder.hook";
import { conversationStorageKeys } from "@/lib/chat/chat-utils";
import { useFeature } from "@/lib/config/config.query";
import { useOrganization } from "@/lib/organization.query";
import { scanText } from "@/lib/sensitive-data";
import { useSkillsPaginated } from "@/lib/skills/skill.query";
import { cn } from "@/lib/utils";
import {
  ChatPromptInputTools,
  type ChatPromptInputToolsProps,
} from "./prompt-input-tools";
import {
  buildSkillCommands,
  DEBUG_COMMAND_VALUE,
  isDebugCommand,
  parseSkillCommand,
  type SkillCommand,
} from "./skill-commands";

const CHAT_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
const CHAT_ATTACHMENT_MAX_MB = CHAT_ATTACHMENT_MAX_BYTES / (1024 * 1024);

export interface ArchestraPromptInputProps
  extends Omit<ChatPromptInputToolsProps, "textareaRef"> {
  onSubmit: (
    message: PromptInputMessage,
    e: FormEvent<HTMLFormElement>,
    options?: { skill?: ChatSkillMetadata },
  ) => void;
  status: ChatStatus;
  // Tools integration props
  agentId: string;
  // Ref for autofocus
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Disable the submit button (e.g., when Playwright setup overlay is visible) */
  submitDisabled?: boolean;
  /** Disable chat input while context compaction is running */
  isContextCompacting?: boolean;
  /** Manually compact the active conversation */
  onCompactConversation?: () => Promise<void> | void;
  /** Whether Playwright setup overlay is visible (for showing Playwright install dialog) */
  isPlaywrightSetupVisible: boolean;
}

type SlashCommand = {
  value: string;
  name: string;
  description: string;
  /** Set for skill commands; absent for built-in commands like /compact. */
  skill?: ChatSkillMetadata;
};

const COMPACT_COMMAND: SlashCommand = {
  value: "/compact",
  name: "compact",
  description: "summarize conversation to prevent hitting the context limit",
};

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
  cachedTokens,
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
  const commandItemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [dismissedSlashCommandValue, setDismissedSlashCommandValue] = useState<
    string | null
  >(null);

  // Derive file upload capabilities from model input modalities
  const showFileUploadButton =
    allowFileUploads && supportsFileUploads(inputModalities);
  const acceptedFileTypes = getAcceptedFileTypes(inputModalities);

  // Chat placeholders from organization settings
  const { data: orgData } = useOrganization();
  const { placeholder: chatPlaceholder } = useChatPlaceholder({
    animate: orgData?.animateChatPlaceholders ?? true,
    placeholders: orgData?.chatPlaceholders,
  });

  // Skills exposed as slash commands, gated by the org flag.
  const skillSlashCommandsEnabled = orgData?.skillSlashCommandsEnabled ?? false;
  const { data: skillsData } = useSkillsPaginated(
    { limit: 100 },
    { enabled: skillSlashCommandsEnabled },
  );
  const skillCommands = useMemo<SkillCommand[]>(() => {
    if (!skillSlashCommandsEnabled || !skillsData?.data) {
      return [];
    }
    return buildSkillCommands(skillsData.data);
  }, [skillSlashCommandsEnabled, skillsData]);

  // /debug toggles per-conversation hook debug chips; admin-only, existing
  // conversation only. Mirrors the server gate (agent-type admin) loosely — the
  // toggle endpoint enforces it for real.
  const { data: isAgentAdmin } = useHasPermissions({ agent: ["admin"] });
  const { data: conversation } = useConversation(conversationId);
  const toggleHooksDebug = useToggleHooksDebug();
  const agentHooksEnabled = useFeature("agentHooksEnabled") ?? false;
  const hooksDebugEnabled = conversation?.hooksDebugEnabled ?? false;
  const canDebug = Boolean(conversationId && isAgentAdmin && agentHooksEnabled);

  // /compact and /debug apply to an existing conversation; skill commands work anywhere.
  const slashCommands = useMemo<SlashCommand[]>(() => {
    const compact =
      conversationId && onCompactConversation ? [COMPACT_COMMAND] : [];
    const debug: SlashCommand[] = canDebug
      ? [
          {
            value: DEBUG_COMMAND_VALUE,
            name: "debug",
            description: hooksDebugEnabled
              ? "hide inline hook debug chips"
              : "show inline hook debug chips",
          },
        ]
      : [];
    return [...compact, ...debug, ...skillCommands];
  }, [
    conversationId,
    onCompactConversation,
    canDebug,
    hooksDebugEnabled,
    skillCommands,
  ]);

  const storageKey = conversationId
    ? conversationStorageKeys(conversationId).draft
    : `archestra_chat_draft_new_${agentId}`;

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

  // The picker stays open while the user is still typing the command token;
  // once a space is entered they have moved on to the prompt body.
  const isSlashCommandOpen =
    slashCommands.length > 0 &&
    controller.textInput.value.startsWith("/") &&
    !/\s/.test(controller.textInput.value) &&
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
      return slashCommands;
    }

    return slashCommands.filter((command) => command.value.startsWith(query));
  }, [controller.textInput.value, isSlashCommandOpen, slashCommands]);

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

  const runDebugCommand = useCallback(() => {
    controller.textInput.clear();
    localStorage.removeItem(storageKey);
    if (!conversationId) return;
    toggleHooksDebug.mutate({
      id: conversationId,
      enabled: !hooksDebugEnabled,
    });
  }, [
    controller.textInput,
    storageKey,
    conversationId,
    hooksDebugEnabled,
    toggleHooksDebug,
  ]);

  const selectSlashCommand = useCallback(
    (command: SlashCommand) => {
      if (command.skill) {
        // a skill command is a prefix — drop it into the input so the user can
        // type an optional prompt; submitting it bare activates the skill as-is
        controller.textInput.setInput(`${command.value} `);
        requestAnimationFrame(() => textareaRef.current?.focus());
        return;
      }
      if (command.value === "/compact") {
        runCompactCommand();
      }
      if (command.value === DEBUG_COMMAND_VALUE) {
        runDebugCommand();
      }
    },
    [controller.textInput, runCompactCommand, runDebugCommand, textareaRef],
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

  const sensitiveDataDetectionEnabled =
    useFeature("chatSecretScanEnabled") ?? false;
  const [sensitiveDataDialogOpen, setSensitiveDataDialogOpen] = useState(false);
  const pendingSubmissionRef = useRef<{
    outgoing: PromptInputMessage;
    e: FormEvent<HTMLFormElement>;
    options?: { skill: ChatSkillMetadata };
    resolve: () => void;
    reject: (reason?: unknown) => void;
  } | null>(null);

  const dispatchSubmit = useCallback(
    (
      outgoing: PromptInputMessage,
      e: FormEvent<HTMLFormElement>,
      options?: { skill: ChatSkillMetadata },
    ) => {
      localStorage.removeItem(storageKey);
      onSubmit(outgoing, e, options);
    },
    [onSubmit, storageKey],
  );

  const handleWrappedSubmit = useCallback(
    (message: PromptInputMessage, e: FormEvent<HTMLFormElement>) => {
      const trimmed = message.text.trim();

      if (trimmed === "/compact" && onCompactConversation) {
        e.preventDefault();
        runCompactCommand();
        return;
      }

      if (isDebugCommand(trimmed) && canDebug) {
        e.preventDefault();
        runDebugCommand();
        return;
      }

      // a skill command activates the skill; any text after the token is an
      // optional prompt — a bare skill command sends with an empty prompt
      let outgoing = message;
      let skill: ChatSkillMetadata | undefined;
      const parsed = parseSkillCommand(trimmed, skillCommands);
      if (parsed) {
        skill = parsed.skill;
        outgoing = { ...message, text: parsed.remaining };
      }

      const options = skill ? { skill } : undefined;

      if (sensitiveDataDetectionEnabled && outgoing.text.length > 0) {
        const findings = scanText(outgoing.text);
        if (findings.length > 0) {
          if (pendingSubmissionRef.current !== null)
            return new Promise<void>(() => {});
          return new Promise<void>((resolve, reject) => {
            pendingSubmissionRef.current = {
              outgoing,
              e,
              options,
              resolve,
              reject,
            };
            setSensitiveDataDialogOpen(true);
          });
        }
      }

      dispatchSubmit(outgoing, e, options);
    },
    [
      canDebug,
      dispatchSubmit,
      onCompactConversation,
      runCompactCommand,
      runDebugCommand,
      sensitiveDataDetectionEnabled,
      skillCommands,
    ],
  );

  const handleSensitiveDataConfirm = useCallback(() => {
    const pending = pendingSubmissionRef.current;
    pendingSubmissionRef.current = null;
    setSensitiveDataDialogOpen(false);
    if (pending) {
      dispatchSubmit(pending.outgoing, pending.e, pending.options);
      pending.resolve();
    }
  }, [dispatchSubmit]);

  const handleSensitiveDataCancel = useCallback(() => {
    const pending = pendingSubmissionRef.current;
    pendingSubmissionRef.current = null;
    setSensitiveDataDialogOpen(false);
    pending?.reject();
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
      } else if (err.code === "max_file_size") {
        toast.error(
          `File is too large. Maximum size is ${CHAT_ATTACHMENT_MAX_MB} MB.`,
        );
      } else if (err.code === "max_files") {
        toast.error("Too many files attached.");
      }
    },
    [showFileUploadButton],
  );

  const submitStatus = status === "error" ? "ready" : status;

  return (
    <div className="relative">
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
                    key={command.skill?.id ?? command.value}
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
                    {isContextCompacting && command.value === "/compact" && (
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
        maxFileSize={CHAT_ATTACHMENT_MAX_BYTES}
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
              disableEnterSubmit={
                status === "submitted" || status === "streaming"
              }
              onKeyDown={handleTextareaKeyDown}
              data-testid={E2eTestId.ChatPromptTextarea}
            />
          )}
        </PromptInputBody>
        <PromptInputFooter>
          <ChatPromptInputTools
            selectedModel={selectedModel}
            onModelChange={onModelChange}
            conversationId={conversationId}
            currentConversationChatApiKeyId={currentConversationChatApiKeyId}
            currentProvider={currentProvider}
            initialApiKeyId={initialApiKeyId}
            onApiKeyChange={onApiKeyChange}
            onProviderChange={onProviderChange}
            allowFileUploads={allowFileUploads}
            isModelsLoading={isModelsLoading}
            tokensUsed={tokensUsed}
            cachedTokens={cachedTokens}
            maxContextLength={maxContextLength}
            inputModalities={inputModalities}
            agentLlmApiKeyId={agentLlmApiKeyId}
            selectorAgentId={selectorAgentId}
            selectorAgentName={selectorAgentName}
            onAgentChange={onAgentChange}
            modelSource={modelSource}
            onResetModelOverride={onResetModelOverride}
            textareaRef={textareaRef}
          />
          <div className="flex items-center gap-2">
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
      <SensitiveDataConfirmDialog
        open={sensitiveDataDialogOpen}
        onConfirm={handleSensitiveDataConfirm}
        onCancel={handleSensitiveDataCancel}
      />
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
  cachedTokens,
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
  const handleProviderFileError = useCallback(
    (err: {
      code: "max_files" | "max_file_size" | "accept";
      message: string;
    }) => {
      if (err.code === "max_file_size") {
        toast.error(
          `File is too large. Maximum size is ${CHAT_ATTACHMENT_MAX_MB} MB.`,
        );
      } else if (err.code === "max_files") {
        toast.error("Too many files attached.");
      }
    },
    [],
  );

  return (
    <div className="flex size-full flex-col justify-end">
      <PromptInputProvider
        maxFileSize={CHAT_ATTACHMENT_MAX_BYTES}
        onError={handleProviderFileError}
      >
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
          cachedTokens={cachedTokens}
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
