"use client";

import type { UIMessage } from "@ai-sdk/react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { QueuedMessage } from "@/components/chat/queued-message";
import { cn } from "@/lib/utils";

// Define the type locally as it matches the usage in contexts/global-chat-context.tsx
type QueuedMessageType = UIMessage & { id: string };

interface QueuedMessagesListProps {
  messages: QueuedMessageType[];
  onDelete: (id: string) => void;
  onSendNow: (id: string) => void;
}

export function QueuedMessagesList({
  messages,
  onDelete,
  onSendNow,
}: QueuedMessagesListProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!messages || messages.length === 0) return null;

  // Logic:
  // - If Messages <= 2: Show all (no expander)
  // - If Messages > 2:
  //   - Collapsed: Show First (next to send) and Last (latest added)
  //   - Expanded: Show all

  const showTruncated = !isExpanded && messages.length > 2;

  return (
    <div className="border rounded-lg bg-muted/30 overflow-hidden backdrop-blur-sm">
      {messages.length > 2 ? (
        <button
          type="button"
          className={cn(
            "flex w-full items-center justify-between bg-muted/50 px-2 py-1 transition-colors select-none",
            "cursor-pointer hover:bg-muted/70 border-0 text-left p-0",
          )}
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
            Queue
            <span className="bg-background/80 px-1 py-0 rounded-full text-[10px] border shadow-sm min-w-[14px] text-center leading-3">
              {messages.length}
            </span>
          </span>
          <div className="h-3.5 w-3.5 text-muted-foreground">
            {isExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronUp className="h-3 w-3" />
            )}
          </div>
        </button>
      ) : (
        <div className="flex items-center justify-between px-2 py-1 bg-muted/50 transition-colors select-none">
          <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
            Queue
            <span className="bg-background/80 px-1 py-0 rounded-full text-[10px] border shadow-sm min-w-[14px] text-center leading-3">
              {messages.length}
            </span>
          </span>
        </div>
      )}

      <div
        className={cn(
          "p-1 space-y-1 transition-all duration-300 ease-in-out",
          isExpanded ? "max-h-[60vh] overflow-y-auto" : "max-h-full",
        )}
      >
        {showTruncated ? (
          <>
            {/* First message (Next to be sent) */}
            <QueuedMessageItem
              msg={messages[0]}
              index={0}
              onDelete={onDelete}
              onSendNow={onSendNow}
            />

            {/* Visual Divider indicating hidden messages */}
            {/* Visual Divider indicating hidden messages */}
            <button
              type="button"
              className="w-full flex items-center justify-center gap-1 py-1 cursor-pointer hover:opacity-70 bg-transparent border-none outline-none"
              onClick={() => setIsExpanded(true)}
              title={`${messages.length - 2} more messages`}
            >
              <div className="h-1 w-1 rounded-full bg-muted-foreground/40" />
              <div className="h-1 w-1 rounded-full bg-muted-foreground/40" />
              <div className="h-1 w-1 rounded-full bg-muted-foreground/40" />
            </button>

            {/* Last message (Latest added) */}
            <QueuedMessageItem
              msg={messages[messages.length - 1]}
              index={messages.length - 1}
              onDelete={onDelete}
              onSendNow={onSendNow}
            />
          </>
        ) : (
          /* Show all messages */
          messages.map((queuedMsg, index) => (
            <QueuedMessageItem
              key={queuedMsg.id}
              msg={queuedMsg}
              index={index}
              onDelete={onDelete}
              onSendNow={onSendNow}
            />
          ))
        )}
      </div>
    </div>
  );
}

function QueuedMessageItem({
  msg,
  index,
  onDelete,
  onSendNow,
}: {
  msg: QueuedMessageType;
  index: number;
  onDelete: (id: string) => void;
  onSendNow: (id: string) => void;
}) {
  const textPart = msg.parts.find(
    (part) => part.type === "text" && "text" in part,
  );

  const fileParts = msg.parts.filter((part) => part.type === "file");

  // Build a preview: use text when available, but always indicate attachments
  // when present (either by filename for file-only messages or a count).
  let preview = "";
  if (textPart && "text" in textPart) {
    preview = textPart.text;
    if (fileParts.length > 0) {
      const count = fileParts.length;
      preview = `${preview} • ${count} attachment${count > 1 ? "s" : ""}`;
    }
  } else if (fileParts.length > 0) {
    // Prefer filename for single file, otherwise show count
    if (fileParts.length === 1) {
      preview =
        fileParts[0].filename || fileParts[0].url || "[File attachment]";
    } else {
      preview = `${fileParts.length} attachments`;
    }
  }

  return (
    <QueuedMessage
      message={preview}
      position={index}
      onDelete={() => onDelete(msg.id)}
      onSendNow={() => onSendNow(msg.id)}
    />
  );
}
