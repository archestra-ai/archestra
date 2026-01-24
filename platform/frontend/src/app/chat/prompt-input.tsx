"use client";

import { E2eTestId } from "@shared";
import type { ChatStatus } from "ai";
import { PaperclipIcon, Plus } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useRef } from "react";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
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
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import { AgentToolsDisplay } from "@/components/chat/agent-tools-display";
import { ChatApiKeySelector } from "@/components/chat/chat-api-key-selector";
import { ChatToolsDisplay } from "@/components/chat/chat-tools-display";
import { KnowledgeGraphUploadIndicator } from "@/components/chat/knowledge-graph-upload-indicator";
import { ModelSelector } from "@/components/chat/model-selector";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAgentDelegations } from "@/lib/agent-tools.query";
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
  // Ref for autofocus
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Whether file uploads are allowed (controlled by organization setting) */
  allowFileUploads?: boolean;
  /** Whether models are still loading - passed to API key selector */
  isModelsLoading?: boolean;
  /** Callback to open edit agent dialog */
  onEditAgent?: () => void;
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
  textareaRef: externalTextareaRef,
  allowFileUploads = false,
  isModelsLoading = false,
  onEditAgent,
}: Omit<ArchestraPromptInputProps, "onSubmit"> & {
  onSubmit: ArchestraPromptInputProps["onSubmit"];
}) => {
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalTextareaRef ?? internalTextareaRef;
  const controller = usePromptInputController();

  // Check if agent has tools or delegations
  const { data: tools = [] } = useProfileToolsWithIds(agentId);
  const { data: delegatedAgents = [] } = useAgentDelegations(agentId);

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

  return (
    <PromptInput globalDrop multiple onSubmit={onSubmit}>
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
        />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          {/* File attachment button - always shown, disabled with tooltip when file uploads are disabled */}
          {allowFileUploads ? (
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger
                data-testid={E2eTestId.ChatFileUploadButton}
              >
                <PaperclipIcon className="size-4" />
              </PromptInputActionMenuTrigger>
              <PromptInputActionMenuContent>
                <PromptInputActionAddAttachments label="Attach files" />
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
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
                File uploads are disabled by your administrator
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
              isModelsLoading={isModelsLoading}
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
          <PromptInputSubmit className="!h-8" status={status} />
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
  textareaRef,
  allowFileUploads = false,
  isModelsLoading = false,
  onEditAgent,
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
          textareaRef={textareaRef}
          allowFileUploads={allowFileUploads}
          isModelsLoading={isModelsLoading}
          onEditAgent={onEditAgent}
        />
      </PromptInputProvider>
    </div>
  );
};

export default ArchestraPromptInput;
