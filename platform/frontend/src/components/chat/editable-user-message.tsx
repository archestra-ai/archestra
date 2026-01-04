"use client";

import { AlertTriangle } from "lucide-react";
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

interface EditableUserMessageProps {
  messageId: string;
  partIndex: number;
  partKey: string;
  text: string;
  isEditing: boolean;
  editDisabled?: boolean;
  onStartEdit: (partKey: string, messageId: string) => void;
  onCancelEdit: () => void;
  onSave: (
    messageId: string,
    partIndex: number,
    newText: string,
  ) => Promise<void>;
}

export function EditableUserMessage({
  messageId,
  partIndex,
  partKey,
  text,
  isEditing,
  editDisabled = false,
  onStartEdit,
  onCancelEdit,
  onSave,
}: EditableUserMessageProps) {
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
    onStartEdit(partKey, messageId);
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
      <Message from="user" className="relative pb-9">
        <MessageContent
          aria-label="Message content"
          className="max-w-[70%] min-w-[50%] px-3 py-0 pt-3 ring-2 !bg-primary/90 ring-primary/50"
        >
          <div>
            <Textarea
              ref={textareaRef}
              value={editedText}
              onChange={(e) => setEditedText(e.target.value)}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              className="max-h-[160px] resize-none border-0 focus-visible:ring-0 shadow-none bg-primary text-sm"
              disabled={isSaving}
              placeholder="Edit your message..."
            />
            <div className="flex gap-2 py-3 justify-between items-start">
              <div className="flex gap-2 items-start">
                <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0 mt-0.5" />
                <span className="text-xs text-primary-foreground/80">
                  Editing this message will <strong>regenerate</strong> the
                  response and <strong>remove</strong> all subsequent messages.
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
                  variant="secondary"
                  onClick={handleSaveEdit}
                  disabled={isSaving || editedText.trim() === ""}
                >
                  Send
                </Button>
              </div>
            </div>
          </div>
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message
      from="user"
      className="relative pb-4 group/message flex-col items-end pr-4 mr-[-1rem]"
    >
      <MessageContent>
        <Response>{text}</Response>
      </MessageContent>
      <MessageActions
        textToCopy={text}
        onEditClick={handleStartEdit}
        editDisabled={editDisabled}
        className="opacity-0 group-hover/message:opacity-100 transition-opacity"
      />
    </Message>
  );
}
