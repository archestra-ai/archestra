"use client";

import { E2eTestId } from "@archestra/shared";
import { QueryLoadError } from "@/components/query-load-error";

/**
 * Shown when the LLM provider keys request fails to load (e.g. no internet),
 * on the surfaces that otherwise gate on "user has no keys". Distinct from the
 * "Add an LLM Provider Key" empty state so a failed fetch isn't misread as a
 * missing-key setup step.
 */
export function ApiKeyLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <QueryLoadError
      title="Couldn't load your LLM providers"
      onRetry={onRetry}
      retryTestId={E2eTestId.ApiKeysLoadErrorRetry}
    />
  );
}
