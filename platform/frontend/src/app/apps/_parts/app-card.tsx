"use client";

import type {
  archestraApiTypes,
  ResourceVisibilityScope,
} from "@archestra/shared";
import { Globe, Trash2, User, Users } from "lucide-react";
import Link from "next/link";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import { cn } from "@/lib/utils";
import { deriveAppGlyph } from "./app-icon";

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];

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
  onDelete,
}: {
  app: AppListItem;
  currentUserId: string | undefined;
  onDelete: (app: Extract<AppListItem, { source: "owned" }>) => void;
}) {
  // Owned apps open the detail page; external UI-providing catalog items open
  // the standalone run page, or route to install when the caller has no
  // accessible install.
  const href =
    app.source === "owned"
      ? `/apps/${app.id}`
      : app.runnable
        ? `/apps/catalog/${app.catalogId}/run`
        : `/mcp/registry?search=${encodeURIComponent(app.name)}`;
  const seed = app.source === "external" ? app.catalogId : app.id;
  const { Icon, tileClass } = deriveAppGlyph(seed);

  return (
    <Card className="group relative min-h-[194px] gap-0 p-5">
      <Link
        href={href}
        className="absolute inset-0 rounded-xl"
        aria-label={`Open ${app.name}`}
      />
      <div className="mb-4 flex items-start justify-between gap-2">
        <div
          className={cn(
            "flex h-11 w-11 items-center justify-center rounded-xl",
            tileClass,
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {app.source === "owned" ? (
            <ResourceVisibilityBadge
              scope={app.scope}
              teams={undefined}
              authorId={app.authorId}
              authorName={undefined}
              currentUserId={currentUserId}
            />
          ) : app.runnable ? (
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
      </div>

      <CardTitle className="truncate">{app.name}</CardTitle>
      {app.description ? (
        <CardDescription className="mt-1 line-clamp-2">
          {app.description}
        </CardDescription>
      ) : null}

      {app.source === "external" ? (
        <div className="mt-auto pt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">
            {app.runnable
              ? "Runs as the server · declares its own network"
              : "Install to run · runs as the server"}
          </span>
        </div>
      ) : null}

      {app.source === "owned" ? (
        <div className="pointer-events-none absolute bottom-3 right-3 opacity-0 transition-opacity group-hover:opacity-100">
          <PermissionButton
            permissions={{ app: ["delete"] }}
            variant="ghost"
            size="icon"
            className="pointer-events-auto relative z-10 h-8 w-8 text-muted-foreground hover:text-destructive"
            aria-label={`Delete ${app.name}`}
            onClick={(e) => {
              e.preventDefault();
              onDelete(app);
            }}
          >
            <Trash2 className="h-4 w-4" />
          </PermissionButton>
        </div>
      ) : null}
    </Card>
  );
}
