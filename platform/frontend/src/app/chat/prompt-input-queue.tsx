"use client";

import type { ChatSkillMetadata } from "@shared";
import type { FileUIPart } from "ai";
import { Trash2Icon } from "lucide-react";
import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemAttachment,
  QueueItemContent,
  QueueItemDescription,
  QueueItemFile,
  QueueItemImage,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
} from "@/components/ai-elements/queue";
import { getAttachmentFallbackLabel } from "@/lib/chat/chat-attachment-display";
import { cn } from "@/lib/utils";

export type QueuedPromptInputMessage = {
  id: string;
  scopeKey: string;
  text: string;
  files: FileUIPart[];
  /** Skill invoked via slash command, if any. */
  skill?: ChatSkillMetadata;
};

type PromptInputQueueProps = {
  messages: QueuedPromptInputMessage[];
  onRemove: (id: string) => void;
  className?: string;
};

export function PromptInputQueue({
  messages,
  onRemove,
  className,
}: PromptInputQueueProps) {
  if (messages.length === 0) {
    return null;
  }

  return (
    <Queue
      aria-label="Queued prompts"
      className={cn(
        "mx-auto max-h-40 w-[calc(100%-0.75rem)] overflow-y-auto rounded-b-none border-input border-b-0 bg-background/95 shadow-md",
        className,
      )}
    >
      <QueueSection>
        <QueueSectionContent>
          <QueueList className="mt-0 -mb-0">
            {messages.map((message) => (
              <QueuedPromptItem
                key={message.id}
                message={message}
                onRemove={onRemove}
              />
            ))}
          </QueueList>
        </QueueSectionContent>
      </QueueSection>
    </Queue>
  );
}

function QueuedPromptItem({
  message,
  onRemove,
}: {
  message: QueuedPromptInputMessage;
  onRemove: (id: string) => void;
}) {
  const title = message.text.trim() || describeFiles(message.files);

  return (
    <QueueItem>
      <div className="flex items-center gap-2">
        <QueueItemIndicator />
        <QueueItemContent className="text-foreground">{title}</QueueItemContent>
        <QueueItemActions>
          <QueueItemAction
            aria-label="Remove queued prompt"
            onClick={() => onRemove(message.id)}
          >
            <Trash2Icon size={12} />
          </QueueItemAction>
        </QueueItemActions>
      </div>
      {message.text.trim() && message.files.length > 0 && (
        <QueueItemDescription>
          {describeFiles(message.files)}
        </QueueItemDescription>
      )}
      {message.files.length > 0 && (
        <QueueItemAttachment>
          {message.files.map((file, index) => {
            const key = `${message.id}:${index}`;
            return file.mediaType?.startsWith("image/") && file.url ? (
              <QueueItemImage
                key={key}
                src={file.url}
                title={getFileLabel(file)}
              />
            ) : (
              <QueueItemFile key={key}>{getFileLabel(file)}</QueueItemFile>
            );
          })}
        </QueueItemAttachment>
      )}
    </QueueItem>
  );
}

function describeFiles(files: FileUIPart[]): string {
  if (files.length === 0) {
    return "Queued prompt";
  }

  return `${files.length} ${files.length === 1 ? "file" : "files"} attached`;
}

function getFileLabel(file: FileUIPart): string {
  return (
    file.filename ??
    getAttachmentFallbackLabel({
      mediaType: file.mediaType,
      filename: file.filename,
    })
  );
}
