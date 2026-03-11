"use client";

import {
  E2eTestId,
  getAcceptedFileTypes,
  type ModelInputModality,
  type SupportedProvider,
  supportsFileUploads,
} from "@shared";
import type { ChatStatus } from "ai";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef } from "react";
import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
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
import { PlaywrightInstallInline } from "@/components/chat/playwright-install-dialog";
import { useProfile } from "@/lib/agent.query";
import { conversationStorageKeys } from "@/lib/chat-utils";

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
}: Omit<ArchestraPromptInputProps, "onSubmit"> & {
  onSubmit: ArchestraPromptInputProps["onSubmit"];
}) => {
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalTextareaRef ?? internalTextareaRef;
  const controller = usePromptInputController();
  const attachments = usePromptInputAttachments();

  // Derive file upload capabilities from model input modalities
  const modelSupportsFiles = supportsFileUploads(inputModalities);
  const acceptedFileTypes = getAcceptedFileTypes(inputModalities);
  // Check if agent has a knowledge base
  const { data: agentData } = useProfile(agentId);

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
            placeholder="What would you like to get done?"
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
          {/* Agent selector (includes model, API key, and attach inside dropdown) */}
          {selectorAgentId !== undefined && onAgentChange && (
            <InitialAgentSelector
              currentAgentId={selectorAgentId}
              onAgentChange={onAgentChange}
              selectedModel={selectedModel}
              onModelChange={onModelChange}
              conversationId={conversationId}
              currentConversationChatApiKeyId={currentConversationChatApiKeyId}
              currentProvider={currentProvider}
              initialApiKeyId={initialApiKeyId}
              onApiKeyChange={onApiKeyChange}
              onProviderChange={onProviderChange}
              messageCount={messageCount}
              isModelsLoading={isModelsLoading}
              agentLlmApiKeyId={agentLlmApiKeyId}
              onAttach={
                showFileUploadButton
                  ? () => attachments.openFileDialog()
                  : undefined
              }
              attachDisabled={!showFileUploadButton}
              attachDisabledReason={
                !allowFileUploads
                  ? "File uploads are disabled by your administrator"
                  : "This model does not support file uploads"
              }
            />
          )}
          {tokensUsed > 0 && maxContextLength && (
            <ContextIndicator
              tokensUsed={tokensUsed}
              maxTokens={maxContextLength}
              size="sm"
            />
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
        />
      </PromptInputProvider>
    </div>
  );
};

export default ArchestraPromptInput;
