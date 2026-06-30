"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { ArrowUpRight, Loader2, Server } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { useOpenAppInChat } from "@/lib/app.query";
import { cn } from "@/lib/utils";

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];
type OwnedApp = Extract<AppListItem, { source: "owned" }>;
type ExternalApp = Extract<AppListItem, { source: "external" }>;

export function AppCard({
  app,
  currentUserId,
}: {
  app: AppListItem;
  currentUserId: string | undefined;
}) {
  return app.source === "owned" ? (
    <OwnedAppCard app={app} currentUserId={currentUserId} />
  ) : (
    <ExternalAppCard app={app} />
  );
}

// Clicking the card opens the app in a new chat; the overlay button covers the
// whole card. The backend seeds a conversation with the app already rendered and
// returns its id, so we navigate straight to it (no model turn).
function OwnedAppCard({
  app,
  currentUserId,
}: {
  app: OwnedApp;
  currentUserId: string | undefined;
}) {
  const router = useRouter();
  const openApp = useOpenAppInChat();
  // Stays true from click through the redirect: the mutation resolving flips
  // isPending off before navigation paints, so spin on this instead. On success
  // the card unmounts mid-navigation, so it never resets; only a failure does.
  const [isOpening, setIsOpening] = useState(false);

  const handleOpen = async () => {
    setIsOpening(true);
    const result = await openApp.mutateAsync(app.id);
    if (result?.conversationId) {
      router.push(`/chat/${result.conversationId}`);
    } else {
      setIsOpening(false);
    }
  };

  return (
    <Card className="group relative flex min-h-[140px] cursor-pointer flex-col gap-0 p-4 transition-shadow hover:shadow-md">
      <button
        type="button"
        onClick={handleOpen}
        disabled={isOpening}
        className="absolute inset-0 rounded-xl"
        aria-label={`Open ${app.name} in new chat`}
      />

      {/* Hover (or in-flight) CTA. The pill is visual only — pointer-events-none
          so the click falls through to the full-card button above. Opening is a
          round-trip, so its loading state keeps the card from looking frozen. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-0 z-[5] flex items-center justify-center rounded-xl bg-background/70 opacity-0 backdrop-blur-[1px] transition-opacity duration-75 group-hover:opacity-100",
          isOpening && "opacity-100",
        )}
      >
        <span
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "shadow-sm",
          )}
        >
          {isOpening ? (
            <>
              <Loader2 className="animate-spin" />
              Opening…
            </>
          ) : (
            <>
              <ArrowUpRight />
              Open in new chat
            </>
          )}
        </span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <ResourceVisibilityBadge
          scope={app.scope}
          teams={undefined}
          authorId={app.authorId}
          authorName={undefined}
          currentUserId={currentUserId}
        />
      </div>

      <CardTitle className="truncate">{app.name}</CardTitle>
      {app.description ? (
        <CardDescription className="mt-1 line-clamp-2">
          {app.description}
        </CardDescription>
      ) : null}
    </Card>
  );
}

// External UI-providing catalog items open the standalone run page, or route to
// install when the caller has no accessible install.
function ExternalAppCard({ app }: { app: ExternalApp }) {
  const href = app.runnable
    ? `/apps/catalog/${app.catalogId}/run`
    : `/mcp/registry?search=${encodeURIComponent(app.name)}`;

  return (
    <Card className="group relative min-h-[140px] gap-0 p-4 transition-colors hover:border-primary/40 hover:shadow-sm">
      <Link
        href={href}
        className="absolute inset-0 rounded-xl"
        aria-label={`Open ${app.name}`}
      />
      <div className="flex items-center gap-2">
        <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
        <CardTitle className="min-w-0 truncate">{app.name}</CardTitle>
      </div>
      {app.description ? (
        <CardDescription className="mt-1 line-clamp-2">
          {app.description}
        </CardDescription>
      ) : null}

      <div className="mt-auto flex items-center gap-2 pt-3 text-xs text-muted-foreground">
        <span className="truncate">
          {app.runnable
            ? "Runs as the server · declares its own network"
            : "Install to run · runs as the server"}
        </span>
      </div>
    </Card>
  );
}
