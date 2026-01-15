"use client";

import { Info } from "lucide-react";
import {
  type KeyboardEventHandler,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
  editDisabled?: boolean;
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
  editDisabled = false,
  onStartEdit,
  onCancelEdit,
  onSave,
}: EditableAssistantMessageProps) {
  const [editedText, setEditedText] = useState(text);
  const [isSaving, setIsSaving] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset edited text when entering edit mode
  useEffect(() => {
    if (isEditing) {
      setEditedText(text);
    }
  }, [isEditing, text]);

  // Auto-focus textarea and move caret to end when entering edit mode
  useLayoutEffect(() => {
    if (isEditing && textareaRef.current) {
      const textarea = textareaRef.current;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      textarea.scrollTop = textarea.scrollHeight;
    }
  }, [isEditing]);

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
        <MessageContent
          aria-label="Message content"
          className="max-w-[70%] min-w-[50%] px-3 py-0 pt-3 ring-2 !bg-secondary/50 ring-primary/50"
        >
          <div>
            <Textarea
              ref={textareaRef}
              value={editedText}
              onChange={(e) => setEditedText(e.target.value)}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              className="max-h-[240px] resize-none border-0 focus-visible:ring-0 shadow-none text-sm !bg-secondary"
              disabled={isSaving}
              placeholder="Edit this response..."
            />
            <div className="flex gap-2 py-3 justify-between items-start">
              <div className="flex gap-2 items-start">
                <Info className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                <span className="text-xs text-muted-foreground">
                  Edit to correct errors or refine the context. This won't
                  regenerate the conversation.
                </span>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="outline-transparent"
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
          </div>
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message from="assistant" className="group/message">
      <div className="relative flex flex-col items-start pb-8 w-full">
        <MessageContent>
          <Response>{text}</Response>
        </MessageContent>
        {showActions && (
          <MessageActions
            textToCopy={text}
            onEditClick={handleStartEdit}
            editDisabled={editDisabled}
            className="absolute -bottom-1 left-0 opacity-0 group-hover/message:opacity-100 transition-opacity"
          />
        )}
      </div>
    </Message>
  );
}
