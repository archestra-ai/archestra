"use client";

import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { formatOriginalError, parseErrorResponse } from "./chat-error.utils";

interface InlineChatErrorProps {
  error: Error;
}

export function InlineChatError({ error }: InlineChatErrorProps) {
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);

  // Try to parse as structured ChatErrorResponse
  const chatError = parseErrorResponse(error);

  if (chatError) {
    return (
      <Message from="assistant">
        <MessageContent className="bg-destructive/10 border border-destructive/20 rounded-lg">
          <div className="flex items-start gap-2 text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">Error</span>
                {chatError.isRetryable && (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <RefreshCw className="h-3 w-3" />
                    Retryable
                  </span>
                )}
              </div>
              <p className="text-sm text-foreground">{chatError.message}</p>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">
                {chatError.code}
              </span>

              {/* Collapsible technical details */}
              {chatError.originalError && (
                <Collapsible
                  open={isDetailsOpen}
                  onOpenChange={setIsDetailsOpen}
                >
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
                      Technical Details
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted/50 p-3 text-xs font-mono whitespace-pre-wrap break-words text-foreground">
                      {formatOriginalError(chatError.originalError)}
                    </pre>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </div>
          </div>
        </MessageContent>
      </Message>
    );
  }

  // Fallback for non-structured errors
  let displayMessage = error.message;
  try {
    const parsed = JSON.parse(error.message);
    displayMessage = JSON.stringify(parsed, null, 2);
  } catch {
    // Not JSON, use as-is
  }

  return (
    <Message from="assistant">
      <MessageContent className="bg-destructive/10 border border-destructive/20 rounded-lg">
        <div className="flex items-start gap-2 text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <span className="font-medium">Error</span>
            <pre className="mt-2 text-xs font-mono whitespace-pre-wrap break-words text-foreground">
              {displayMessage}
            </pre>
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}
