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
import { ChatToolsDisplay } from "@/components/chat/chat-tools-display";
import { ModelSelector } from "@/components/chat/model-selector";
import Divider from "@/components/divider";

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
}: Omit<ArchestraPromptInputProps, "onSubmit"> & {
  onSubmit: ArchestraPromptInputProps["onSubmit"];
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
          <ChatToolsDisplay agentId={agentId} conversationId={conversationId} />
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
        />
      </PromptInputProvider>
    </div>
  );
};

export default ArchestraPromptInput;
