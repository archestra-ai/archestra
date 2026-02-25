"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { ChatOpsProvider } from "./types";

export function ChannelTilesEmptyState({
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
      ? "Add bot to channel, send a message, wait for reply"
      : "Send a message to the bot, wait for reply";
  return (
    <Card>
      <CardContent className="py-12 flex flex-col items-center gap-4">
        <p className="text-lg font-semibold">No channels discovered yet</p>
        <p className="text-muted-foreground text-center max-w-lg">
          {message} and click{" "}
          {isRefreshing ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Refreshing…
            </span>
          ) : (
            <Button
              variant="link"
              className="h-auto p-0 text-md"
              onClick={onRefresh}
            >
              Refresh
            </Button>
          )}{" "}
          to see them here.
        </p>
      </CardContent>
    </Card>
  );
}
