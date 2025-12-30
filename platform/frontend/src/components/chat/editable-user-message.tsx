"use client";

import { Check, Copy, Pencil } from "lucide-react";
import { type KeyboardEventHandler, useEffect, useState } from "react";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Response } from "@/components/ai-elements/response";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface EditableUserMessageProps {
  messageId: string;
  partIndex: number;
  partKey: string;
  text: string;
  isEditing: boolean;
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
  onStartEdit,
  onCancelEdit,
  onSave,
}: EditableUserMessageProps) {
  const [editedText, setEditedText] = useState(text);
  const [isSaving, setIsSaving] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isComposing, setIsComposing] = useState(false);

  // Reset edited text when entering edit mode
  useEffect(() => {
    if (isEditing) {
      setEditedText(text);
    }
  }, [isEditing, text]);

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
        <MessageContent className="max-w-[70%] min-w-[50%] px-0 py-0 ring-2 ring-primary/50">
          <div>
            <Textarea
              value={editedText}
              onChange={(e) => setEditedText(e.target.value)}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              className="max-h-[160px] resize-none border-0 focus-visible:ring-0 shadow-none"
              disabled={isSaving}
              placeholder="Edit your message..."
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
                variant="secondary"
                onClick={handleSaveEdit}
                disabled={isSaving || editedText.trim() === ""}
              >
                Send
              </Button>
            </div>
          </div>
        </MessageContent>
      </Message>
    );
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 500);
  };

  return (
    <Message from="user" className="relative pb-9">
      <MessageContent className="group/message">
        <Response>{text}</Response>
        <div className="absolute bottom-1 right-0 flex gap-1 opacity-0 group-hover/message:opacity-100 transition-opacity z-10">
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 hover:bg-transparent"
            onClick={handleCopy}
            disabled={isCopied}
          >
            {isCopied ? (
              <Check className="h-3 w-3 text-green-500" />
            ) : (
              <Copy className="h-3 w-3 text-muted-foreground hover:text-primary/70 transition-colors" />
            )}
            <span className="sr-only">
              {isCopied ? "Copied!" : "Copy message"}
            </span>
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 hover:bg-transparent"
            onClick={handleStartEdit}
          >
            <Pencil className="h-3 w-3 text-muted-foreground hover:text-primary/70 transition-colors" />
            <span className="sr-only">Edit message</span>
          </Button>
        </div>
      </MessageContent>
    </Message>
  );
}
