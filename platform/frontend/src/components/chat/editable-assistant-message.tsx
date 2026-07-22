"use client";

import type { ChatMessageFeedback } from "@archestra/shared";
import { Info } from "lucide-react";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Response } from "@/components/ai-elements/response";
import {
  EditableMessageEditor,
  useMessageEditor,
} from "@/components/chat/editable-message-editor";
import type { KnowledgeGraphCitationsProps } from "@/components/chat/knowledge-graph-citations";
import { KnowledgeGraphCitations } from "@/components/chat/knowledge-graph-citations";
import { MessageActions } from "@/components/chat/message-actions";

interface EditableAssistantMessageProps {
  messageId: string;
  partIndex: number;
  partKey: string;
  text: string;
  isEditing: boolean;
  showActions: boolean;
  citationParts?: KnowledgeGraphCitationsProps["parts"];
  editDisabled?: boolean;
  isStreaming?: boolean;
  onStartEdit: (partKey: string) => void;
  onCancelEdit: () => void;
  onSave: (
    messageId: string,
    partIndex: number,
    newText: string,
  ) => Promise<void>;
  feedback?: ChatMessageFeedback | null;
  onFeedbackChange?: (feedback: ChatMessageFeedback | null) => void;
  feedbackDisabled?: boolean;
}

export function EditableAssistantMessage({
  messageId,
  partIndex,
  partKey,
  text,
  isEditing,
  showActions,
  citationParts,
  editDisabled = false,
  isStreaming = false,
  onStartEdit,
  onCancelEdit,
  onSave,
  feedback = null,
  onFeedbackChange,
  feedbackDisabled = false,
}: EditableAssistantMessageProps) {
  const editor = useMessageEditor({
    text,
    isEditing,
    onSave: (newText) => onSave(messageId, partIndex, newText),
    onCancelEdit,
  });

  const handleStartEdit = () => {
    onStartEdit(partKey);
  };

  if (isEditing) {
    return (
      <EditableMessageEditor
        from="assistant"
        editor={editor}
        outerClassName="relative pt-0"
        contentClassName="max-w-[70%] min-w-[50%] px-3 py-0 pt-3 ring-2 !bg-secondary/50 ring-primary/50"
        textareaClassName="max-h-[240px] resize-none border-0 focus-visible:ring-0 shadow-none text-sm !bg-secondary"
        placeholder="Edit this response..."
        saveLabel="Save"
        banner={
          <div className="flex gap-2 items-start">
            <Info className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
            <span className="text-xs text-muted-foreground">
              Edit to correct errors or refine the context. This won't
              regenerate the conversation.
            </span>
          </div>
        }
      />
    );
  }

  return (
    <Message from="assistant" className="group/message">
      {/* The actions are absolutely positioned outside the flow: mounting
          them when streaming ends must not steal width from the bubble,
          which would make the finished text visibly rewrap. From md up they
          hang off the bubble's right edge; that doesn't fit a phone viewport
          (it would widen the horizontal scroll range), so below md they
          overlay just under the bubble instead. Reveal is hover on desktop
          and the tap-synthesized hover on touch; pointer-events gating keeps
          the hidden panel from swallowing taps meant for the content. */}
      <div className="relative max-w-[80%]">
        <MessageContent className="max-w-none">
          <Response isStreaming={isStreaming}>{text}</Response>
          {citationParts && <KnowledgeGraphCitations parts={citationParts} />}
        </MessageContent>
        {showActions && (
          <MessageActions
            textToCopy={text}
            onEditClick={handleStartEdit}
            editDisabled={editDisabled}
            feedback={feedback}
            onFeedbackChange={onFeedbackChange}
            feedbackDisabled={feedbackDisabled}
            className="pointer-events-none absolute top-full left-0 z-10 mt-1 opacity-0 transition-opacity group-hover/message:pointer-events-auto group-hover/message:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 md:top-1/2 md:left-full md:mt-0 md:ml-2 md:-translate-y-1/2"
          />
        )}
      </div>
    </Message>
  );
}
