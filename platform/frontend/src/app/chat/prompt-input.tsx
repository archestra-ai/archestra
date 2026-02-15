"use client";

import {
  E2eTestId,
  getAcceptedFileTypes,
  getSupportedFileTypesDescription,
  type ModelInputModality,
  supportsFileUploads,
} from "@shared";
import type { ChatStatus } from "ai";
import { PaperclipIcon, Plus } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef } from "react";
import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  type PromptInputMessage,
  PromptInputProvider,
  PromptInputSpeechButton,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import { AgentToolsDisplay } from "@/components/chat/agent-tools-display";
import { ChatApiKeySelector } from "@/components/chat/chat-api-key-selector";
import { ChatToolsDisplay } from "@/components/chat/chat-tools-display";
import { ContextIndicator } from "@/components/chat/context-indicator";
import { KnowledgeGraphUploadIndicator } from "@/components/chat/knowledge-graph-upload-indicator";
import { ModelSelector } from "@/components/chat/model-selector";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAgentDelegations } from "@/lib/agent-tools.query";
import { useHasPermissions } from "@/lib/auth.query";
import { useProfileToolsWithIds } from "@/lib/chat.query";
import type { SupportedChatProvider } from "@/lib/chat-settings.query";

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
  currentProvider?: SupportedChatProvider;
  /** Selected API key ID for initial chat mode */
  initialApiKeyId?: string | null;
  /** Callback for API key change in initial chat mode (no conversation) */
  onApiKeyChange?: (apiKeyId: string) => void;
  /** Callback when user selects an API key with a different provider */
  onProviderChange?: (
    provider: SupportedChatProvider,
    apiKeyId: string,
  ) => void;
  // Ref for autofocus
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Whether file uploads are allowed (controlled by organization setting) */
  allowFileUploads?: boolean;
  /** Whether models are still loading - passed to API key selector */
  isModelsLoading?: boolean;
  /** Callback to open edit agent dialog */
  onEditAgent?: () => void;
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
  onEditAgent,
  tokensUsed = 0,
  maxContextLength,
  inputModalities,
  agentLlmApiKeyId,
  submitDisabled = false,
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
  const supportedTypesDescription =
    getSupportedFileTypesDescription(inputModalities);

  // Check if agent has tools or delegations
  const { data: tools = [] } = useProfileToolsWithIds(agentId);
  const { data: delegatedAgents = [] } = useAgentDelegations(agentId);

  // Check if user can update organization settings (to show settings link in tooltip)
  const { data: canUpdateOrganization } = useHasPermissions({
    organization: ["update"],
  });

  const storageKey = conversationId
    ? `archestra_chat_draft_${conversationId}`
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

  // Check if there are tools or delegated agents
  const hasTools = tools.length > 0;
  const hasDelegatedAgents = delegatedAgents.length > 0;
  const hasContent = hasTools || hasDelegatedAgents;

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
      {agentId && (
        <PromptInputHeader>
          {hasContent ? (
            <>
              {hasTools && (
                <ChatToolsDisplay
                  agentId={agentId}
                  conversationId={conversationId}
                />
              )}
              {hasDelegatedAgents && (
                <AgentToolsDisplay
                  agentId={agentId}
                  conversationId={conversationId}
                  addAgentsButton={null}
                />
              )}
            </>
          ) : (
            <div className="flex items-start">
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 gap-1.5 text-xs border-dashed"
                onClick={onEditAgent}
              >
                <Plus className="h-3 w-3" />
                <span>Add tools & sub-agents</span>
              </Button>
            </div>
          )}
        </PromptInputHeader>
      )}
      {/* File attachments display - shown inline above textarea */}
      <PromptInputAttachments className="px-3 pt-2 pb-0">
        {(attachment) => <PromptInputAttachment data={attachment} />}
      </PromptInputAttachments>
      <PromptInputBody>
        <PromptInputTextarea
          placeholder="Type a message..."
          ref={textareaRef}
          className="px-4"
          disableEnterSubmit={status !== "ready" && status !== "error"}
          data-testid={E2eTestId.ChatPromptTextarea}
        />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          {/* File attachment button - direct click opens file browser, shows tooltip when disabled */}
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
                  canUpdateOrganization ? (
                    <span>
                      File uploads are disabled.{" "}
                      <a
                        href="/settings/security"
                        className="underline hover:no-underline"
                        aria-label="Enable file uploads in security settings"
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
          />
          {tokensUsed > 0 && maxContextLength && (
            <ContextIndicator
              tokensUsed={tokensUsed}
              maxTokens={maxContextLength}
              size="sm"
            />
          )}
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
        </PromptInputTools>
        <div className="flex items-center gap-2">
          <KnowledgeGraphUploadIndicator
            attachmentCount={controller.attachments.files.length}
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
  onEditAgent,
  tokensUsed = 0,
  maxContextLength,
  inputModalities,
  agentLlmApiKeyId,
  submitDisabled,
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
          onEditAgent={onEditAgent}
          tokensUsed={tokensUsed}
          maxContextLength={maxContextLength}
          inputModalities={inputModalities}
          agentLlmApiKeyId={agentLlmApiKeyId}
          submitDisabled={submitDisabled}
        />
      </PromptInputProvider>
    </div>
  );
};

export default ArchestraPromptInput;
