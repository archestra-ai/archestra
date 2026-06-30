"use client";

import type {
  archestraApiTypes,
  ResourceVisibilityScope,
} from "@archestra/shared";
import { Globe, Loader2, MessageSquare, User, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { useOpenAppInChat } from "@/lib/app.query";
import { cn } from "@/lib/utils";

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];
type OwnedApp = Extract<AppListItem, { source: "owned" }>;
type ExternalApp = Extract<AppListItem, { source: "external" }>;

// An external app is listed once per catalog item; its availability chips show
// which scopes the caller has an install in. Stable order keeps chips from
// reshuffling between renders.
const SCOPE_META: Record<
  ResourceVisibilityScope,
  { label: string; Icon: typeof Globe }
> = {
  personal: { label: "Personal", Icon: User },
  team: { label: "Team", Icon: Users },
  org: { label: "Organization", Icon: Globe },
};
const SCOPE_ORDER: ResourceVisibilityScope[] = ["personal", "team", "org"];

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
        aria-label={`View and edit ${app.name} in chat`}
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
        <span className={cn(buttonVariants({ size: "sm" }), "shadow-sm")}>
          {isOpening ? (
            <>
              <Loader2 className="animate-spin" />
              Opening…
            </>
          ) : (
            <>
              <MessageSquare />
              View & edit in chat
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
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {app.runnable ? (
          SCOPE_ORDER.filter((s) => app.availabilityScopes.includes(s)).map(
            (s) => {
              const { label, Icon: ScopeIcon } = SCOPE_META[s];
              return (
                <Badge key={s} variant="outline" className="gap-1 text-xs">
                  <ScopeIcon className="h-3 w-3" />
                  {label}
                </Badge>
              );
            },
          )
        ) : (
          <Badge variant="outline" className="text-xs text-muted-foreground">
            Not installed
          </Badge>
        )}
      </div>

      <CardTitle className="truncate">{app.name}</CardTitle>
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
