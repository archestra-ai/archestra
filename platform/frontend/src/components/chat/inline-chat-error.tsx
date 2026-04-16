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
import { useHasPermissions } from "@/lib/auth/auth.query";
import type { ModelSource } from "@/lib/chat/use-chat-preferences";
import {
  formatOriginalError,
  mapClientError,
  parseErrorResponse,
} from "./chat-error.utils";

interface InlineChatErrorProps {
  error: Error;
  conversationId?: string;
  supportMessage?: string | null;
  slimChatErrorUi?: boolean;
  agentName?: string;
  selectedModel?: string;
  modelSource?: ModelSource | null;
}

export function InlineChatError({
  error,
  conversationId,
  supportMessage,
  slimChatErrorUi = false,
  agentName,
  selectedModel,
  modelSource,
}: InlineChatErrorProps) {
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const { data: isAdmin } = useHasPermissions({
    organizationSettings: ["read"],
  });
  const chatError = parseErrorResponse(error) ?? mapClientError(error);
  // Conversation IDs double as chat session IDs for the end-user chat flow.
  const sessionId = chatError.sessionId ?? conversationId;

  const refEntries: { label: string; value: string }[] = [];
  if (sessionId) refEntries.push({ label: "Session", value: sessionId });
  if (chatError.traceId)
    refEntries.push({ label: "Trace", value: chatError.traceId });
  if (chatError.spanId)
    refEntries.push({ label: "Span", value: chatError.spanId });

  const copyDebugInfo = () => {
    const lines: string[] = [];

    lines.push(supportMessage?.trim() || chatError.message);
    if (!slimChatErrorUi) {
      if (agentName) lines.push(`Agent: ${agentName}`);
      if (selectedModel) lines.push(`Model: ${selectedModel}`);
      if (chatError.originalError?.provider) {
        lines.push(`Provider: ${chatError.originalError.provider}`);
      }
      lines.push(`Model source: ${formatModelSource(modelSource)}`);
      lines.push("");
      lines.push(
        `Code: ${chatError.code}${chatError.isRetryable ? " (retryable)" : ""}`,
      );
      if (chatError.originalError) {
        lines.push(formatOriginalError(chatError.originalError));
      }
    }
    for (const entry of refEntries) {
      lines.push(`${entry.label}: ${entry.value}`);
    }

    navigator.clipboard.writeText(lines.join("\n"));
    toast.success(
      slimChatErrorUi ? "Error details copied" : "Debug info copied",
    );
  };

  if (slimChatErrorUi) {
    return (
      <Message from="assistant">
        <MessageContent className="bg-destructive/10 border border-destructive/20 rounded-lg">
          <div className="flex items-start gap-2 text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div className="flex-1 space-y-2">
              <p className="text-sm text-foreground">
                {supportMessage ? supportMessage : chatError.message}
              </p>

              <div className="flex items-center gap-1.5 flex-wrap">
                {refEntries.map((entry) => (
                  <span
                    key={entry.label}
                    className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground font-mono"
                  >
                    <span className="opacity-60">{entry.label}</span>
                    <span>{entry.value}</span>
                  </span>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
                  onClick={copyDebugInfo}
                  aria-label="Copy error details"
                  title="Copy error details"
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
            </div>
          </div>
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message from="assistant">
      <MessageContent className="bg-destructive/10 border border-destructive/20 rounded-lg">
        <div className="flex items-start gap-2 text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div className="flex-1 space-y-2">
            {supportMessage ? (
              <p className="text-sm text-foreground">{supportMessage}</p>
            ) : (
              <p className="text-sm text-foreground">{chatError.message}</p>
            )}

            <div className="flex items-center gap-1.5 flex-wrap">
              {agentName && (
                <span className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground font-mono">
                  <span className="opacity-60">Agent</span>
                  <span>{agentName}</span>
                </span>
              )}
              {selectedModel && (
                <span className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground font-mono">
                  <span className="opacity-60">Model</span>
                  <span>{selectedModel}</span>
                </span>
              )}
              {chatError.originalError?.provider && (
                <span className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground font-mono">
                  <span className="opacity-60">Provider</span>
                  <span>{chatError.originalError.provider}</span>
                </span>
              )}
              <span className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground font-mono">
                <span className="opacity-60">Model source</span>
                <span>{formatModelSource(modelSource)}</span>
              </span>
              {refEntries.map((entry) => (
                <span
                  key={entry.label}
                  className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground font-mono"
                >
                  <span className="opacity-60">{entry.label}</span>
                  <span>{entry.value}</span>
                </span>
              ))}
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
                onClick={copyDebugInfo}
                aria-label="Copy debug info"
                title="Copy debug info"
              >
                <Copy className="h-3 w-3" />
              </Button>
            </div>

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

function formatModelSource(source: ModelSource | null | undefined): string {
  switch (source) {
    case "agent":
      return "agent";
    case "organization":
      return "organization";
    case "user":
      return "user override";
    default:
      return "no model selected";
  }
}
