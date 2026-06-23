"use client";

import type { ChatSkillMetadata } from "@archestra/shared";
import { AlertTriangle, FileText, Paperclip, Sparkles } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
  EditableMessageEditor,
  useMessageEditor,
} from "@/components/chat/editable-message-editor";
import { MessageActions } from "@/components/chat/message-actions";
import { UserMessageText } from "@/components/chat/user-message-text";
import { Badge } from "@/components/ui/badge";
import {
  getAttachmentFallbackLabel,
  isCsvAttachment,
  isPlainTextAttachment,
} from "@/lib/chat/chat-attachment-display";
import { cn } from "@/lib/utils";

export interface FileAttachment {
  url: string;
  mediaType: string;
  filename?: string;
}

interface EditableUserMessageProps {
  messageId: string;
  partIndex: number;
  partKey: string;
  text: string;
  isEditing: boolean;
  editDisabled?: boolean;
  attachments?: FileAttachment[];
  /** Skill the user invoked via slash command for this message, if any. */
  skill?: ChatSkillMetadata;
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
  attachments = [],
  skill,
  onStartEdit,
  onCancelEdit,
  onSave,
}: EditableUserMessageProps) {
  const [isRegenerateConfirming, setIsRegenerateConfirming] = useState(false);
  const editor = useMessageEditor({
    text,
    isEditing,
    onSave: (newText) => onSave(messageId, partIndex, newText),
    onCancelEdit,
  });
  const { setIsSaving } = editor;

  const handleStartEdit = () => {
    onStartEdit(partKey, messageId);
  };

  const handleRegenerateClick = async () => {
    if (!isRegenerateConfirming) {
      setIsRegenerateConfirming(true);
      return;
    }
    // Second click - confirm and regenerate
    setIsSaving(true);
    try {
      await onSave(messageId, partIndex, text);
    } finally {
      setIsSaving(false);
      setIsRegenerateConfirming(false);
    }
  };

  if (isEditing) {
    return (
      <EditableMessageEditor
        from="user"
        editor={editor}
        outerClassName="relative pb-9"
        contentClassName="max-w-[70%] min-w-[50%] px-3 py-0 pt-3 ring-2 !bg-primary/90 ring-primary/50"
        textareaClassName="max-h-[160px] resize-none border-0 focus-visible:ring-0 shadow-none bg-primary text-sm"
        placeholder="Edit your message..."
        saveLabel="Send"
        saveVariant="secondary"
        banner={
          <div className="flex gap-2 items-start">
            <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0 mt-0.5" />
            <span className="text-xs text-primary-foreground/80">
              Editing this message will <strong>regenerate</strong> the response
              and <strong>remove</strong> all subsequent messages.
            </span>
          </div>
        }
      />
    );
  }

  const imageAttachments = attachments.filter((a) =>
    a.mediaType?.startsWith("image/"),
  );
  const otherAttachments = attachments.filter(
    (a) => !a.mediaType?.startsWith("image/"),
  );

  return (
    <Message
      from="user"
      className="group/message"
      onMouseLeave={() => setIsRegenerateConfirming(false)}
    >
      <div className="relative flex flex-col items-end pb-2 w-full">
        {/* Skill invoked via slash command */}
        {skill && (
          <Badge variant="secondary" className="mb-2 gap-1 text-xs">
            <Sparkles className="h-3 w-3" />
            {skill.name}
          </Badge>
        )}
        {/* Image attachments above the message bubble */}
        {imageAttachments.length > 0 && (
          <div className="flex flex-wrap gap-1 justify-end mb-2">
            {imageAttachments.map((attachment) => (
              <img
                key={attachment.url}
                src={attachment.url}
                alt={attachment.filename || "Attached image"}
                className="max-h-32 rounded-lg object-cover"
              />
            ))}
          </div>
        )}
        {/* Other file attachments above the message bubble */}
        {otherAttachments.length > 0 && (
          <div className="flex flex-wrap gap-1 justify-end mb-2">
            {otherAttachments.map((attachment) => (
              <div
                key={attachment.url}
                className="flex items-center gap-1 rounded-lg border bg-muted/50 p-1"
              >
                <Link
                  href={attachment.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  download={attachment.filename}
                  className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm transition-colors hover:bg-muted"
                >
                  {isCsvAttachment(attachment.mediaType, attachment.filename) ||
                  isPlainTextAttachment(
                    attachment.mediaType,
                    attachment.filename,
                  ) ? (
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate max-w-[200px]">
                    {attachment.filename ||
                      getAttachmentFallbackLabel({
                        mediaType: attachment.mediaType,
                        filename: attachment.filename,
                      })}
                  </span>
                </Link>
              </div>
            ))}
          </div>
        )}
        {/* Text message bubble - only show if there's text */}
        {text && (
          <div className="group/user-message-text-row flex max-w-[80%] items-center justify-end gap-2">
            <MessageActions
              textToCopy={text}
              onEditClick={handleStartEdit}
              onRegenerateClick={handleRegenerateClick}
              isRegenerateConfirming={isRegenerateConfirming}
              editDisabled={editDisabled}
              className={cn(
                "shrink-0 transition-opacity",
                isRegenerateConfirming
                  ? "opacity-100"
                  : "pointer-events-none opacity-0 group-hover/user-message-text-row:pointer-events-auto group-hover/user-message-text-row:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100",
              )}
            />
            <MessageContent className="max-w-none">
              <UserMessageText text={text} />
            </MessageContent>
          </div>
        )}
      </div>
    </Message>
  );
}
