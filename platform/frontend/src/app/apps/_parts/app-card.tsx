"use client";

import type {
  archestraApiTypes,
  ResourceVisibilityScope,
} from "@archestra/shared";
import { Globe, User, Users } from "lucide-react";
import Link from "next/link";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { buildAppChatHandoffUrl } from "@/lib/apps/app-chat-handoff";

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

// Clicking the card opens the app in a new chat; the chat-link overlay covers
// the whole card.
function OwnedAppCard({
  app,
  currentUserId,
}: {
  app: OwnedApp;
  currentUserId: string | undefined;
}) {
  return (
    <Card className="relative flex min-h-[194px] cursor-pointer flex-col gap-0 p-5 transition-shadow hover:shadow-md">
      <Link
        href={buildAppChatHandoffUrl({ appId: app.id, appName: app.name })}
        className="absolute inset-0 rounded-xl"
        aria-label={`Chat with ${app.name}`}
      />

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
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
    <Card className="group relative min-h-[194px] gap-0 p-5 transition-colors hover:border-primary/40 hover:shadow-sm">
      <Link
        href={href}
        className="absolute inset-0 rounded-xl"
        aria-label={`Open ${app.name}`}
      />
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
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

      <div className="mt-auto flex items-center gap-2 pt-4 text-xs text-muted-foreground">
        <span className="truncate">
          {app.runnable
            ? "Runs as the server · declares its own network"
            : "Install to run · runs as the server"}
        </span>
      </div>
    </Card>
  );
}
