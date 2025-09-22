import { UIMessage } from 'ai';
import { AlertCircle, ChevronDown, ChevronUp, Clock } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { Button } from '@ui/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@ui/components/ui/collapsible';

interface ErrorMessageProps {
  message: UIMessage;
}

interface ParsedError {
  type?: string;
  code?: string;
  message?: string;
  error?: {
    type?: string;
    code?: string;
    message?: string;
    headers?: Record<string, string>;
  };
  [key: string]: any;
}

export default function ErrorMessage({ message }: ErrorMessageProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Extract and parse error data
  const { errorData, userFriendlyMessage, retryInfo, isRateLimit, isToolsNotSupported } = useMemo(() => {
    let rawErrorText = 'An error occurred';
    let parsedError: ParsedError | null = null;

    if (message.parts && message.parts.length > 0) {
      const textPart = message.parts.find((part) => part.type === 'text');
      if (textPart && 'text' in textPart) {
        rawErrorText = textPart.text;
        // Try to parse JSON
        try {
          parsedError = JSON.parse(rawErrorText);
        } catch {
          // Not JSON, use as-is
        }
      }
    }

    // Determine error type and generate user-friendly message
    let userFriendlyMessage = 'An unexpected error occurred. Please try again.';
    let retryInfo: { shouldRetry: boolean; retryAfter?: number } = { shouldRetry: false };
    let isRateLimit = false;
    let isToolsNotSupported = false;

    if (parsedError) {
      const errorCode = parsedError.error?.code || parsedError.code;
      const errorMessage = parsedError.error?.message || parsedError.message || '';

      // Rate limit errors
      if (errorCode === 'rate_limit_exceeded' || errorMessage.includes('rate limit')) {
        isRateLimit = true;
        userFriendlyMessage = "Rate limit exceeded. The request was too large or you've made too many requests.";

        // Extract retry time from headers if available
        const headers = parsedError.error?.headers;
        if (headers) {
          const resetTokens = headers['x-ratelimit-reset-tokens'];
          const resetRequests = headers['x-ratelimit-reset-requests'];
          if (resetTokens || resetRequests) {
            const resetTime = resetTokens || resetRequests;
            // Parse time (e.g., "120ms", "5s", "2m")
            let retryMs = 0;
            if (resetTime.includes('ms')) {
              retryMs = parseInt(resetTime);
            } else if (resetTime.includes('s')) {
              retryMs = parseInt(resetTime) * 1000;
            } else if (resetTime.includes('m')) {
              retryMs = parseInt(resetTime) * 60 * 1000;
            }

            if (retryMs > 0) {
              retryInfo = { shouldRetry: true, retryAfter: retryMs };
              const seconds = Math.ceil(retryMs / 1000);
              userFriendlyMessage += ` Please wait ${seconds} second${seconds > 1 ? 's' : ''} before trying again.`;
            }
          }
        }

        // Add limit info if available
        if (errorMessage.includes('Limit')) {
          const limitMatch = errorMessage.match(/Limit (\d+), Requested (\d+)/);
          if (limitMatch) {
            userFriendlyMessage += ` (Limit: ${limitMatch[1]}, Requested: ${limitMatch[2]})`;
          }
        }
      }
      // Models not supporting tools
      else if (
        errorMessage.toLowerCase().includes('tools parameter is not supported') ||
        errorMessage.toLowerCase().includes('does not support tools')
      ) {
        isToolsNotSupported = true;
        userFriendlyMessage =
          'This model does not support tools/functions. Please select a different model that supports tool calling.';
      }
      // Authentication errors
      else if (errorCode === 'unauthorized' || errorCode === 'authentication_error') {
        userFriendlyMessage = 'Authentication failed. Please check your API key and try again.';
      }
      // Model errors
      else if (errorCode === 'model_not_found') {
        userFriendlyMessage = 'The selected model was not found. Please choose a different model.';
      }
      // Server errors
      else if (errorCode?.startsWith('5') || errorMessage.includes('server')) {
        userFriendlyMessage = 'A server error occurred. Please try again later.';
      }
      // Network errors
      else if (errorMessage.includes('network') || errorMessage.includes('connection')) {
        userFriendlyMessage = 'Network connection error. Please check your connection and try again.';
      }
      // Generic error with message
      else if (errorMessage) {
        // Use the first sentence of the error message if it's reasonably short
        const firstSentence = errorMessage.split('.')[0];
        if (firstSentence.length < 150) {
          userFriendlyMessage = firstSentence + '.';
        }
      }
    }

    return {
      errorData: parsedError ? JSON.stringify(parsedError, null, 2) : rawErrorText,
      userFriendlyMessage,
      retryInfo,
      isRateLimit,
      isToolsNotSupported,
    };
  }, [message]);

  const handleReportIssue = useCallback(() => {
    const issueTitle = encodeURIComponent(`Chat Error: ${userFriendlyMessage.substring(0, 100)}`);
    const issueBody = encodeURIComponent(
      `## Error Details\n\n\`\`\`json\n${errorData}\n\`\`\`\n\n## User-facing error message\n${userFriendlyMessage}\n\n## Steps to reproduce\n[Please describe the steps that led to this error]\n\n## Expected behavior\n[What did you expect to happen?]\n\n## Additional context\n[Any other context about the problem]`
    );
    const url = `https://github.com/archestra-ai/archestra/issues/new?title=${issueTitle}&body=${issueBody}`;

    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  }, [errorData, userFriendlyMessage]);

  return (
    <div className="space-y-3">
      {/* Main error message */}
      <div className="flex items-center gap-3 pt-2">
        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-red-100 dark:bg-red-900/20 flex-shrink-0">
          <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
        </div>
        <div className="flex-1 space-y-2">
          <p className="text-sm font-medium text-foreground">{userFriendlyMessage}</p>

          {/* Rate limit indicator */}
          {isRateLimit && retryInfo.shouldRetry && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>Retry available in {Math.ceil((retryInfo.retryAfter || 0) / 1000)} seconds</span>
            </div>
          )}

          {/* Model suggestion for tools not supported */}
          {isToolsNotSupported && (
            <p className="text-sm text-muted-foreground">
              Tip: Models like GPT-4, Claude, or Gemini Pro support tool calling.
            </p>
          )}
        </div>
      </div>

      {/* Collapsible error details */}
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-between text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <span className="text-xs">Show error details</span>
            {isOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 rounded-md bg-muted/50 p-3">
            <pre className="text-xs text-muted-foreground overflow-x-auto whitespace-pre-wrap break-words">
              {errorData}
            </pre>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Report issue hint */}
      <div className="text-xs text-muted-foreground">
        If this error persists, please{' '}
        <button
          onClick={handleReportIssue}
          className="text-primary underline hover:no-underline bg-transparent border-0 p-0 cursor-pointer"
        >
          report an issue
        </button>{' '}
        with the error details above.
      </div>
    </div>
  );
}
