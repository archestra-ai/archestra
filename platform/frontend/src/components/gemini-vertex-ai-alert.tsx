"use client";

import { Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface GeminiVertexAiAlertProps {
  /**
   * Variant of the alert:
   * - "full": Shows title and "Learn more" link (for main page)
   * - "compact": Smaller version without title (for dialogs)
   */
  variant?: "full" | "compact";
}

/**
 * Alert component explaining that Gemini is configured via Vertex AI.
 * Used in LLM API Keys settings page and create dialog.
 */
export function GeminiVertexAiAlert({
  variant = "full",
}: GeminiVertexAiAlertProps) {
  const docsUrl =
    "https://archestra.ai/docs/platform-supported-llm-providers#using-vertex-ai";

  if (variant === "compact") {
    return (
      <Alert className="py-2">
        <Info className="h-4 w-4" />
        <AlertDescription className="inline text-sm">
          Gemini uses{" "}
          <a
            href={docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline hover:text-foreground inline"
          >
            Vertex AI
          </a>{" "}
          with Application Default Credentials—no API key needed.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert>
      <Info className="h-4 w-4" />
      <AlertTitle>Google Gemini configured via Vertex AI</AlertTitle>
      <AlertDescription className="inline">
        Gemini uses{" "}
        <a
          href="https://cloud.google.com/vertex-ai"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline hover:text-foreground inline"
        >
          Vertex AI
        </a>{" "}
        with Application Default Credentials—no API key needed.{" "}
        <a
          href={docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline hover:text-foreground inline"
        >
          Learn more
        </a>
      </AlertDescription>
    </Alert>
  );
}
