import { UIMessage } from 'ai';
import { AlertCircle } from 'lucide-react';

interface ErrorMessageProps {
  message: UIMessage;
}

export default function ErrorMessage({ message }: ErrorMessageProps) {
  // Extract error text from message parts
  let errorText = 'An error occurred';
  if (message.parts && message.parts.length > 0) {
    const textPart = message.parts.find((part) => part.type === 'text');
    if (textPart && 'text' in textPart) {
      errorText = textPart.text;
      // Try to parse and format JSON
      try {
        const parsed = JSON.parse(errorText);
        errorText = JSON.stringify(parsed, null, 2);
      } catch {
        // Not JSON, use as-is
      }
    }
  }

  return (
    <div className="flex items-start gap-2">
      <AlertCircle className="h-4 w-4 text-red-500 mt-1 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-red-600 dark:text-red-400 break-words whitespace-pre-wrap">{errorText}</p>
      </div>
    </div>
  );
}
