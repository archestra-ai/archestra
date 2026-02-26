"use client";

import { Loader2, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { ChatOpsProvider } from "./types";

export function ChannelsEmptyState({
  onRefresh,
  isRefreshing,
  provider,
}: {
  onRefresh: () => void;
  isRefreshing: boolean;
  provider: ChatOpsProvider;
}) {
  const message =
    provider === "slack"
      ? "Add the bot to a channel, send a message, and wait for a reply."
      : "Mention @archestra in a channel and wait for a reply.";

  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Radio />
        </EmptyMedia>
        <EmptyTitle>No channels discovered yet</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={isRefreshing}
        >
          {isRefreshing ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Refreshing…
            </>
          ) : (
            "Refresh"
          )}
        </Button>
      </EmptyContent>
    </Empty>
  );
}
