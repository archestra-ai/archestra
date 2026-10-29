"use client";

import { AlertTriangle, Lock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { getApiRefusal } from "@/lib/utils/api";

/**
 * Shown when a query fails to load (e.g. no internet) on a surface that
 * otherwise gates on emptiness. Keeps a failed fetch from being misread as a
 * genuinely empty result. Pair with a query's `isLoadingError`/`isError` and a
 * `refetch` so the user can retry without a full reload.
 *
 * Pass the query's `error` so a refusal does not blame the connection: a 403
 * says the reader lacks access (retrying cannot fix that, so no Retry), and a
 * 401 asks them to sign in again.
 */
export function QueryLoadError({
  title,
  description = "Check your internet connection and try again.",
  error,
  onRetry,
  retryTestId,
  className = "h-full",
}: {
  title: string;
  description?: string;
  error?: unknown;
  onRetry: () => void;
  retryTestId?: string;
  className?: string;
}) {
  const refusal = getApiRefusal(error);
  if (refusal === "forbidden") {
    return (
      <Empty className={className}>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Lock />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>
            You don&apos;t have access to this. Ask an admin if you need it.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Empty className={className}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AlertTriangle />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>
          {refusal === "signed-out"
            ? "Your session ended. Sign in again to continue."
            : description}
        </EmptyDescription>
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
