"use client";

import { RefreshCw, WifiOff } from "lucide-react";
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
 * Shown when a gating query (e.g. the LLM provider keys check) fails to reach
 * the server — typically offline. Distinguishes a connectivity outage from a
 * genuine empty state ("no API key configured"), so the user isn't told to add
 * a key when the real problem is the network. The retry action refetches.
 */
export function ConnectivityError({
  title = "Couldn't reach the server",
  description = "Check your connection and try again.",
  onRetry,
  isRetrying,
}: {
  title?: string;
  description?: string;
  onRetry: () => void;
  isRetrying?: boolean;
}) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <WifiOff />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onRetry} disabled={isRetrying}>
          <RefreshCw
            className={isRetrying ? "h-4 w-4 animate-spin" : "h-4 w-4"}
          />
          {isRetrying ? "Retrying…" : "Try again"}
        </Button>
      </EmptyContent>
    </Empty>
  );
}
