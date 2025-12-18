"use client";

import { type ChatErrorResponse, isChatErrorResponse } from "@shared";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface ChatErrorProps {
  error: Error;
}

/**
 * Parse the error message to extract a ChatErrorResponse if possible
 */
function parseErrorResponse(error: Error): ChatErrorResponse | null {
  try {
    const parsed = JSON.parse(error.message);
    if (isChatErrorResponse(parsed)) {
      return parsed;
    }
  } catch {
    // Not JSON or not a ChatErrorResponse
  }
  return null;
}

/**
 * Format the original error details for display
 */
function formatOriginalError(
  originalError: ChatErrorResponse["originalError"],
): string {
  if (!originalError) return "No additional details available";

  const parts: string[] = [];

  if (originalError.provider) {
    parts.push(`Provider: ${originalError.provider}`);
  }
  if (originalError.status) {
    parts.push(`Status: ${originalError.status}`);
  }
  if (originalError.type) {
    parts.push(`Type: ${originalError.type}`);
  }
  if (originalError.message) {
    parts.push(`Message: ${originalError.message}`);
  }
  if (originalError.raw) {
    try {
      parts.push(`\nRaw Error:\n${JSON.stringify(originalError.raw, null, 2)}`);
    } catch {
      parts.push(`\nRaw Error: [Unable to stringify]`);
    }
  }

  return parts.join("\n") || "No additional details available";
}

export function ChatError({ error }: ChatErrorProps) {
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);

  // Try to parse as structured ChatErrorResponse
  const chatError = parseErrorResponse(error);

  // If we have a structured error, show the user-friendly version
  if (chatError) {
    return (
      <div className="border-b p-4 bg-destructive/5">
        <Alert variant="destructive" className="max-w-3xl mx-auto">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle className="flex items-center gap-2">
            Error
            {chatError.isRetryable && (
              <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
                <RefreshCw className="h-3 w-3" />
                Retryable
              </span>
            )}
          </AlertTitle>
          <AlertDescription className="space-y-3">
            {/* User-friendly message */}
            <p className="text-sm">{chatError.message}</p>

            {/* Error code badge */}
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">
                {chatError.code}
              </span>
            </div>

            {/* Collapsible technical details */}
            {chatError.originalError && (
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
                    Technical Details
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted/50 p-3 text-xs font-mono whitespace-pre-wrap break-words">
                    {formatOriginalError(chatError.originalError)}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            )}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // Fallback for non-structured errors (legacy behavior)
  let displayMessage = error.message;
  let isJson = false;

  try {
    const parsed = JSON.parse(error.message);
    displayMessage = JSON.stringify(parsed, null, 2);
    isJson = true;
  } catch {
    // Not JSON, use as-is
  }

  return (
    <div className="border-b p-4 bg-destructive/5">
      <Alert variant="destructive" className="max-w-3xl mx-auto">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>
          {isJson ? (
            <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted/50 p-3 text-xs font-mono whitespace-pre-wrap break-words">
              {displayMessage}
            </pre>
          ) : (
            <span className="whitespace-pre-wrap break-words">
              {displayMessage}
            </span>
          )}
        </AlertDescription>
      </Alert>
    </div>
  );
}
