import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface ChatErrorProps {
  error: Error;
}

export function ChatError({ error }: ChatErrorProps) {
  // Try to parse as JSON for better formatting
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
