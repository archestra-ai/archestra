"use client";

import type { ChatStatus } from "ai";
import type { FormEvent } from "react";
import { useCallback, useRef } from "react";
import {
  PromptInput,
  PromptInputBody,
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
import { ChatApiKeySelector } from "@/components/chat/chat-api-key-selector";
import { ChatToolsDisplay } from "@/components/chat/chat-tools-display";
import { ModelSelector } from "@/components/chat/model-selector";
import { ProfileSelector } from "@/components/chat/profile-selector";
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
  /** Callback when user switches to a different provider's API key - should switch to first model of that provider */
  onProviderChange?: (provider: SupportedChatProvider) => void;
  // Ref for autofocus
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Callback for profile change in initial chat mode (no conversation) */
  onProfileChange?: (agentId: string) => void;
  /** Called when user tries to interact with tools in initial state (no conversation) */
  onCreateConversation?: () => void;
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
  onProfileChange,
  onCreateConversation,
}: Omit<ArchestraPromptInputProps, "onSubmit"> & {
  onSubmit: ArchestraPromptInputProps["onSubmit"];
}) => {
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalTextareaRef ?? internalTextareaRef;
  const controller = usePromptInputController();

  // Handle speech transcription by updating controller state
  const handleTranscriptionChange = useCallback(
    (text: string) => {
      controller.textInput.setInput(text);
    },
    [controller.textInput],
  );

  return (
    <PromptInput globalDrop multiple onSubmit={onSubmit}>
      <PromptInputHeader className="pt-3">
        {agentId && (
          <div className="flex flex-wrap items-center gap-2">
            <ProfileSelector
              currentAgentId={agentId}
              conversationId={conversationId}
              onProfileChange={onProfileChange}
            />
            <ChatToolsDisplay
              agentId={agentId}
              conversationId={conversationId}
              onCreateConversation={onCreateConversation}
            />
          </div>
        )}
      </PromptInputHeader>
      <PromptInputBody>
        <PromptInputTextarea
          placeholder="Type a message..."
          ref={textareaRef}
          className="px-4"
          disableEnterSubmit={status !== "ready"}
        />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <ModelSelector
            selectedModel={selectedModel}
            onModelChange={onModelChange}
            messageCount={messageCount}
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
              onProviderChange={onProviderChange}
            />
          )}
        </PromptInputTools>
        <div className="flex items-center gap-2">
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
  onProviderChange,
  textareaRef,
  onProfileChange,
  onCreateConversation,
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
          onProfileChange={onProfileChange}
          onCreateConversation={onCreateConversation}
        />
      </PromptInputProvider>
    </div>
  );
};

export default ArchestraPromptInput;
