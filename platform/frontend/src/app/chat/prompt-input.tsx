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
import Divider from "@/components/divider";
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
  conversationId: string;
  promptId?: string | null;
  // API key selector props
  currentConversationChatApiKeyId?: string | null;
  currentProvider?: SupportedChatProvider;
  // Ref for autofocus
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
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
  promptId,
  currentConversationChatApiKeyId,
  currentProvider,
  textareaRef: externalTextareaRef,
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
        {agentId && conversationId && (
          <div className="flex items-center gap-2">
            <ProfileSelector
              currentAgentId={agentId}
              conversationId={conversationId}
            />
            <ChatToolsDisplay
              agentId={agentId}
              conversationId={conversationId}
              promptId={promptId}
            />
          </div>
        )}
      </PromptInputHeader>
      <Divider className="my-1 w-[calc(100%-2rem)] mx-auto" />
      <PromptInputBody>
        <PromptInputTextarea
          placeholder="Type a message..."
          ref={textareaRef}
          className="px-4"
        />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <ModelSelector
            selectedModel={selectedModel}
            onModelChange={onModelChange}
            messageCount={messageCount}
          />
          {conversationId && (
            <ChatApiKeySelector
              conversationId={conversationId}
              currentProvider={currentProvider}
              currentConversationChatApiKeyId={
                currentConversationChatApiKeyId ?? null
              }
              messageCount={messageCount}
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
  promptId,
  currentConversationChatApiKeyId,
  currentProvider,
  textareaRef,
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
          promptId={promptId}
          currentConversationChatApiKeyId={currentConversationChatApiKeyId}
          currentProvider={currentProvider}
          textareaRef={textareaRef}
        />
      </PromptInputProvider>
    </div>
  );
};

export default ArchestraPromptInput;
