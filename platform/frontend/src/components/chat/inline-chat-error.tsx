"use client";

import { AlertCircle, Copy } from "lucide-react";
import { toast } from "sonner";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { mapClientError, parseErrorResponse } from "./chat-error.utils";

interface InlineChatErrorProps {
  error: Error;
  conversationId?: string;
  supportMessage?: string | null;
}

export function InlineChatError({
  error,
  conversationId,
  supportMessage,
}: InlineChatErrorProps) {
  const chatError = parseErrorResponse(error) ?? mapClientError(error);
  const sessionId = chatError.sessionId ?? conversationId;

  const refEntries: { label: string; value: string }[] = [];
  if (sessionId) refEntries.push({ label: "Session", value: sessionId });
  if (chatError.traceId)
    refEntries.push({ label: "Trace", value: chatError.traceId });
  if (chatError.spanId)
    refEntries.push({ label: "Span", value: chatError.spanId });

  const copyErrorDetails = () => {
    const lines = [supportMessage?.trim() || chatError.message];
    for (const entry of refEntries) {
      lines.push(`${entry.label}: ${entry.value}`);
    }

    navigator.clipboard.writeText(lines.join("\n"));
    toast.success("Error details copied");
  };

  return (
    <Message from="assistant">
      <MessageContent className="bg-destructive/10 border border-destructive/20 rounded-lg">
        <div className="flex items-start gap-2 text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div className="flex-1 space-y-2">
            <p className="text-sm text-foreground">
              {supportMessage ? supportMessage : chatError.message}
            </p>

            {refEntries.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                {refEntries.map((entry) => (
                  <span
                    key={entry.label}
                    className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground font-mono"
                  >
                    <span className="opacity-60">{entry.label}</span>
                    <span>{entry.value.slice(0, 8)}</span>
                  </span>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
                  onClick={copyErrorDetails}
                  aria-label="Copy error details"
                  title="Copy error details"
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}
