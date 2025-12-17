"use client";

import type { ChatStatus } from "ai";
import type { FormEvent } from "react";
import { useRef } from "react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  type PromptInputMessage,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
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

const ArchestraPromptInput = ({
  onSubmit,
  status,
  selectedModel,
  onModelChange,
  messageCount = 0,
  agentId,
  conversationId,
}: ArchestraPromptInputProps) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div className="flex size-full flex-col justify-end">
      <PromptInputProvider>
        <PromptInput globalDrop multiple onSubmit={onSubmit}>
          <PromptInputHeader className="pt-3">
            {agentId && conversationId && (
              <ChatToolsDisplay
                agentId={agentId}
                conversationId={conversationId}
              />
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
              <PromptInputSubmit className="!h-8" status={status} />
            </div>
          </PromptInputFooter>
        </PromptInput>
      </PromptInputProvider>
    </div>
  );
};

export default ArchestraPromptInput;
