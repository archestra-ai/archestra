"use client";

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
 * Shown when a query fails to load (e.g. no internet) on a surface that
 * otherwise gates on emptiness. Keeps a failed fetch from being misread as a
 * genuinely empty result. Pair with a query's `isLoadingError`/`isError` and a
 * `refetch` so the user can retry without a full reload.
 */
export function QueryLoadError({
  title,
  description = "Check your internet connection and try again.",
  onRetry,
  retryTestId,
  className = "h-full",
}: {
  title: string;
  description?: string;
  onRetry: () => void;
  retryTestId?: string;
  className?: string;
}) {
  return (
    <Empty className={className}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AlertTriangle />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button data-testid={retryTestId} variant="outline" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" />
          Retry
        </Button>
      </EmptyContent>
    </Empty>
  );
}
