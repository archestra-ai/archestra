"use client";

import { providerDisplayNames, type SupportedProvider } from "@shared";
import { Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface EnvConfiguredProviderAlertProps {
  /**
   * List of provider names configured via environment variables
   */
  providers: SupportedProvider[];
  /**
   * Variant of the alert:
   * - "full": Shows title and description (for main page)
   * - "compact": Smaller version without title (for dialogs)
   */
  variant?: "full" | "compact";
}

/**
 * Alert component showing which LLM providers are configured via environment variables.
 * Used in LLM API Keys settings page.
 */
export function EnvConfiguredProviderAlert({
  providers,
  variant = "full",
}: EnvConfiguredProviderAlertProps) {
  if (providers.length === 0) {
    return null;
  }

  const providerNames = providers
    .map((p) => providerDisplayNames[p] ?? p)
    .join(", ");

  const docsUrl = "https://archestra.ai/docs/platform-adding-llm-providers";

  if (variant === "compact") {
    return (
      <Alert className="py-2">
        <Info className="h-4 w-4" />
        <AlertDescription className="inline text-sm">
          {providerNames} configured via environment variables—no UI setup
          needed.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert>
      <Info className="h-4 w-4" />
      <AlertTitle>LLM Provider(s) configured via environment</AlertTitle>
      <AlertDescription className="inline">
        <strong>{providerNames}</strong> {providers.length === 1 ? "is" : "are"}{" "}
        configured using environment variables. These providers are available
        for use without adding API keys here.{" "}
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
