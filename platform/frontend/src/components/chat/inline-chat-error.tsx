"use client";

import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useHasPermissions } from "@/lib/auth.query";
import {
  formatOriginalError,
  mapClientError,
  parseErrorResponse,
} from "./chat-error.utils";

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
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const { data: isAdmin } = useHasPermissions({
    organizationSettings: ["read"],
  });

  const chatError = parseErrorResponse(error) ?? mapClientError(error);

  // Build reference IDs for the compact row + "copy all" action
  const refEntries: { label: string; value: string }[] = [];
  if (conversationId)
    refEntries.push({ label: "Conversation", value: conversationId });
  if (chatError.traceId)
    refEntries.push({ label: "Trace", value: chatError.traceId });
  if (chatError.spanId)
    refEntries.push({ label: "Span", value: chatError.spanId });

  const copyAllIds = () => {
    const text = refEntries.map((e) => `${e.label}: ${e.value}`).join("\n");
    navigator.clipboard.writeText(text);
    toast.success("Reference IDs copied");
  };

  return (
    <Message from="assistant">
      <MessageContent className="bg-destructive/10 border border-destructive/20 rounded-lg">
        <div className="flex items-start gap-2 text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div className="flex-1 space-y-2">
            {/* Primary: support message or error message */}
            {supportMessage ? (
              <p className="text-sm text-foreground">{supportMessage}</p>
            ) : (
              <p className="text-sm text-foreground">{chatError.message}</p>
            )}

            {/* Reference IDs — compact row with copy-all button */}
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
                  onClick={copyAllIds}
                  title="Copy all reference IDs"
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
            )}

            {/* Admin-only: collapsible error details */}
            {isAdmin && (
              <Collapsible open={isDetailsOpen} onOpenChange={setIsDetailsOpen}>
                <CollapsibleTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {isDetailsOpen ? (
                      <ChevronDown className="h-3 w-3 mr-1" />
                    ) : (
                      <ChevronRight className="h-3 w-3 mr-1" />
                    )}
                    Error Details
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-2 mt-1">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">
                      {chatError.code}
                    </span>
                    {chatError.isRetryable && (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <RefreshCw className="h-3 w-3" />
                        Retryable
                      </span>
                    )}
                  </div>
                  {/* Show the actual error message here if support message replaced it above */}
                  {supportMessage && (
                    <p className="text-sm text-foreground">
                      {chatError.message}
                    </p>
                  )}
                  {chatError.originalError && (
                    <pre className="max-h-48 overflow-auto rounded-md bg-muted/50 p-3 text-xs font-mono whitespace-pre-wrap break-words text-foreground">
                      {formatOriginalError(chatError.originalError)}
                    </pre>
                  )}
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}
