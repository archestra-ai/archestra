"use client";

import type { UIMessage } from "@ai-sdk/react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type ArchestraPromptInputProps = {
  onSubmit: (
    message: { text?: string; files?: any[] },
    event: React.FormEvent<HTMLFormElement>,
  ) => void;
  status: "ready" | "submitted" | "streaming" | "error";
  selectedModel?: string;
  onModelChange?: (model: string) => void; // reserved for future model picker
  messageCount: number;
  agentId?: string;
  conversationId?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement>;
  className?: string;
};

export default function ArchestraPromptInput({
  onSubmit,
  status,
  selectedModel,
  messageCount,
  agentId,
  conversationId,
  textareaRef,
  className,
}: ArchestraPromptInputProps) {
  return (
    <div
      className={cn("space-y-2", className)}
      data-agent-id={agentId}
      data-conversation-id={conversationId}
    >
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="font-medium">Conversation</span>
          <Badge variant="outline" className="text-[11px] px-2 py-0.5">
            {messageCount} message{messageCount === 1 ? "" : "s"}
          </Badge>
        </div>
        {selectedModel ? (
          <span className="text-muted-foreground">Model: {selectedModel}</span>
        ) : null}
      </div>

      <PromptInput onSubmit={onSubmit} className="bg-card/60 shadow-sm">
        <PromptInputBody>
          <PromptInputTextarea
            ref={textareaRef}
            placeholder="Type a message..."
            defaultValue=""
          />
        </PromptInputBody>
        <PromptInputToolbar>
          <PromptInputTools />
          <PromptInputSubmit
            status={status === "error" ? "ready" : status}
          />
        </PromptInputToolbar>
      </PromptInput>
    </div>
  );
}
