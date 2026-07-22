"use client";

import {
  type KeyboardEventHandler,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function useMessageEditor(params: {
  text: string;
  isEditing: boolean;
  onSave: (text: string) => Promise<void>;
  onCancelEdit: () => void;
}): {
  editedText: string;
  setEditedText: (text: string) => void;
  isSaving: boolean;
  setIsSaving: (saving: boolean) => void;
  isComposing: boolean;
  setIsComposing: (composing: boolean) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  handleCancelEdit: () => void;
  handleSaveEdit: () => Promise<void>;
  handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
} {
  const { text, isEditing, onSave, onCancelEdit } = params;
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

  const handleCancelEdit = () => {
    setEditedText(text);
    onCancelEdit();
  };

  const handleSaveEdit = async () => {
    setIsSaving(true);
    try {
      await onSave(editedText);
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

  return {
    editedText,
    setEditedText,
    isSaving,
    setIsSaving,
    isComposing,
    setIsComposing,
    textareaRef,
    handleCancelEdit,
    handleSaveEdit,
    handleKeyDown,
  };
}

interface EditableMessageEditorProps {
  from: "assistant" | "user";
  editor: ReturnType<typeof useMessageEditor>;
  banner: ReactNode;
  saveLabel: "Save" | "Send";
  saveVariant?: "default" | "secondary";
  placeholder: string;
  textareaClassName: string;
  contentClassName: string;
  outerClassName: string;
}

export function EditableMessageEditor({
  from,
  editor,
  banner,
  saveLabel,
  saveVariant = "default",
  placeholder,
  textareaClassName,
  contentClassName,
  outerClassName,
}: EditableMessageEditorProps) {
  const {
    editedText,
    setEditedText,
    isSaving,
    setIsComposing,
    textareaRef,
    handleCancelEdit,
    handleSaveEdit,
    handleKeyDown,
  } = editor;

  return (
    <Message from={from} className={outerClassName}>
      <MessageContent aria-label="Message content" className={contentClassName}>
        <div>
          <Textarea
            ref={textareaRef}
            value={editedText}
            onChange={(e) => setEditedText(e.target.value)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            className={textareaClassName}
            disabled={isSaving}
            placeholder={placeholder}
            aria-label={placeholder || "Edit message"}
          />
          <div className="flex gap-2 py-3 justify-between items-start">
            {banner}
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
                variant={saveVariant}
                onClick={handleSaveEdit}
                disabled={isSaving || editedText.trim() === ""}
              >
                {saveLabel}
              </Button>
            </div>
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}
