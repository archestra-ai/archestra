"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { AppWindow } from "lucide-react";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";

type App = archestraApiTypes.GetAppResponses["200"];

export function AppTitle({
  app,
  currentUserId,
}: {
  app: App;
  currentUserId: string | undefined;
}) {
  return (
    <span className="flex items-center gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
        <AppWindow className="h-5 w-5 text-muted-foreground" />
      </span>
      <span className="truncate text-2xl font-semibold tracking-tight">
        {app.name}
      </span>
      <ResourceVisibilityBadge
        scope={app.scope}
        teams={app.teams}
        authorId={app.authorId}
        authorName={undefined}
        currentUserId={currentUserId}
      />
    </span>
  );
}

// Author display names aren't returned by the API, so owner is "you" or "—".
export function AppMeta({
  app,
  currentUserId,
}: {
  app: App;
  currentUserId: string | undefined;
}) {
  const owner = currentUserId && app.authorId === currentUserId ? "you" : "—";
  return <span>Owned by {owner}</span>;
}
