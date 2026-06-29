"use client";

import { E2eTestId } from "@archestra/shared";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/**
 * Shown when the LLM provider keys request fails to load (e.g. no internet),
 * on the surfaces that otherwise gate on "user has no keys". Distinct from the
 * "Add an LLM Provider Key" empty state so a failed fetch isn't misread as a
 * missing-key setup step.
 */
export function ApiKeyLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AlertTriangle />
        </EmptyMedia>
        <EmptyTitle>Couldn&apos;t load your LLM providers</EmptyTitle>
        <EmptyDescription>
          Check your internet connection and try again.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          data-testid={E2eTestId.ApiKeysLoadErrorRetry}
          variant="outline"
          onClick={onRetry}
        >
          <RefreshCw className="h-4 w-4" />
          Retry
        </Button>
      </EmptyContent>
    </Empty>
  );
}
