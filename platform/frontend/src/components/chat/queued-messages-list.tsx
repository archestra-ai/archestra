"use client";

import type { UIMessage } from "@ai-sdk/react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { QueuedMessage } from "@/components/chat/queued-message";
import { Button } from "@/components/ui/button";
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
            <div
                className={cn(
                    "flex items-center justify-between px-2 py-1 bg-muted/50 transition-colors select-none",
                    messages.length > 2 && "cursor-pointer hover:bg-muted/70",
                )}
                onClick={() => messages.length > 2 && setIsExpanded(!isExpanded)}
                role={messages.length > 2 ? "button" : undefined}
                tabIndex={messages.length > 2 ? 0 : undefined}
                onKeyDown={(e) => {
                    if (messages.length > 2 && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        setIsExpanded(!isExpanded);
                    }
                }}
            >
                <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                    Queue
                    <span className="bg-background/80 px-1 py-0 rounded-full text-[10px] border shadow-sm min-w-[14px] text-center leading-3">
                        {messages.length}
                    </span>
                </span>
                {messages.length > 2 && (
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        className="h-3.5 w-3.5 text-muted-foreground"
                        onClick={(e) => {
                            e.stopPropagation();
                            setIsExpanded(!isExpanded);
                        }}
                    >
                        {isExpanded ? (
                            <ChevronDown className="h-3 w-3" />
                        ) : (
                            <ChevronUp className="h-3 w-3" />
                        )}
                        <span className="sr-only">Toggle queue</span>
                    </Button>
                )}
            </div>

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
                        <div
                            className="flex items-center justify-center gap-1 py-1 cursor-pointer hover:opacity-70"
                            onClick={() => setIsExpanded(true)}
                            title={`${messages.length - 2} more messages`}
                        >
                            <div className="h-1 w-1 rounded-full bg-muted-foreground/40" />
                            <div className="h-1 w-1 rounded-full bg-muted-foreground/40" />
                            <div className="h-1 w-1 rounded-full bg-muted-foreground/40" />
                        </div>

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

    return (
        <QueuedMessage
            message={textPart && "text" in textPart ? textPart.text : ""}
            position={index}
            onDelete={() => onDelete(msg.id)}
            onSendNow={() => onSendNow(msg.id)}
        />
    );
}
