"use client";

import { type KeyboardEventHandler, useEffect, useState } from "react";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Response } from "@/components/ai-elements/response";
import { MessageActions } from "@/components/chat/message-actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface EditableAssistantMessageProps {
  messageId: string;
  partIndex: number;
  partKey: string;
  text: string;
  isEditing: boolean;
  showActions: boolean;
  onStartEdit: (partKey: string) => void;
  onCancelEdit: () => void;
  onSave: (
    messageId: string,
    partIndex: number,
    newText: string,
  ) => Promise<void>;
}

export function EditableAssistantMessage({
  messageId,
  partIndex,
  partKey,
  text,
  isEditing,
  showActions,
  onStartEdit,
  onCancelEdit,
  onSave,
}: EditableAssistantMessageProps) {
  const [editedText, setEditedText] = useState(text);
  const [isSaving, setIsSaving] = useState(false);
  const [isComposing, setIsComposing] = useState(false);

  // Reset edited text when entering edit mode
  useEffect(() => {
    if (isEditing) {
      setEditedText(text);
    }
  }, [isEditing, text]);

  const handleStartEdit = () => {
    onStartEdit(partKey);
  };

  const handleCancelEdit = () => {
    setEditedText(text);
    onCancelEdit();
  };

  const handleSaveEdit = async () => {
    setIsSaving(true);
    try {
      await onSave(messageId, partIndex, editedText);
      onCancelEdit();
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (e.key === "Enter") {
      // IME (Input Method Editor) check for international keyboards
      if (isComposing || e.nativeEvent.isComposing) {
        return;
      }

      // Allow Shift+Enter for new line
      if (e.shiftKey) {
        return;
      }

      e.preventDefault();

      // Don't submit if saving or text is empty
      if (isSaving || editedText.trim() === "") {
        return;
      }

      handleSaveEdit();
    } else if (e.key === "Escape") {
      handleCancelEdit();
    }
  };

  if (isEditing) {
    return (
      <Message from="assistant" className="relative pt-0">
        <MessageContent className="max-w-[70%] min-w-[50%] px-0 py-0 ring-2 ring-primary/50">
          <div>
            <Textarea
              value={editedText}
              onChange={(e) => setEditedText(e.target.value)}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              className="max-h-[240px] resize-none border-0 focus-visible:ring-0 shadow-none"
              disabled={isSaving}
            />
            <div className="flex gap-2 p-2 justify-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={handleCancelEdit}
                disabled={isSaving}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSaveEdit}
                disabled={isSaving || editedText.trim() === ""}
              >
                Save
              </Button>
            </div>
          </div>
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message from="assistant" className="relative pt-0 group/message">
      <MessageContent>
        <Response>{text}</Response>
      </MessageContent>
      {showActions && (
        <MessageActions
          textToCopy={text}
          onEditClick={handleStartEdit}
          className="absolute top-[100%] opacity-0 group-hover/message:opacity-100 transition-opacity mt-[-0.5rem]"
        />
      )}
    </Message>
  );
}
