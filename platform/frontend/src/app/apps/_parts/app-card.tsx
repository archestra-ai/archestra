"use client";

import type {
  archestraApiTypes,
  ResourceVisibilityScope,
} from "@archestra/shared";
import {
  Globe,
  MessageSquare,
  MoreHorizontal,
  User,
  Users,
} from "lucide-react";
import Link from "next/link";
import { AppSettingsMenu } from "@/components/mcp-app/app-settings-menu";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

// Clicking the card chats with the app; everything else lives in the top-right
// kebab. The chat-link overlay sits under the content, so only the kebab (and
// its portalled menu/dialogs) is raised above it.
function OwnedAppCard({
  app,
  currentUserId,
}: {
  app: OwnedApp;
  currentUserId: string | undefined;
}) {
  return (
    <Card className="group relative flex min-h-[194px] flex-col gap-0 p-5 transition-colors hover:border-primary/40 hover:shadow-sm">
      <Link
        href={buildAppChatHandoffUrl({ appId: app.id, appName: app.name })}
        className="absolute inset-0 rounded-xl"
        aria-label={`Chat with ${app.name}`}
      />

      {/* Hover scrim + centered chat CTA. pointer-events-none so the click
          falls through to the chat link beneath; the kebab (z-10) stays above. */}
      <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center rounded-xl bg-background/75 opacity-0 backdrop-blur-[1px] transition-opacity duration-150 group-hover:opacity-100">
        <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
          <MessageSquare className="h-4 w-4" />
          Open in new chat
        </span>
      </div>

      <div className="absolute right-3 top-3 z-10">
        <AppSettingsMenu
          app={app}
          openInNewTab
          trigger={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="App actions"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          }
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1.5 pr-8">
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
