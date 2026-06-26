"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Globe, Route, User, Users } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { resolveCatalogEnvironmentLabel } from "@/app/mcp/registry/_parts/catalog-environment-label";
import { useEnvironments } from "@/lib/environment.query";
import { useDefaultEnvironment } from "@/lib/organization.query";

type App = archestraApiTypes.GetAppResponses["200"];

/**
 * Bottom-bar meta strip for an owned-app frame: muted-text segments
 * (`v{version} · <visibility> · <environment>`) on the left and an "Edit MCP
 * server" link on the right that deep-links to the registry pre-filtered to this
 * app. The registry surfaces an app's catalog backing only on the beta route
 * (`includeApps`), and it filters by catalog name (which equals `app.name`), so
 * the search lands on this one app's card.
 */
export function McpAppMetaBar({
  app,
  version,
}: {
  app: App;
  version: number | null;
}) {
  const { data: environmentList } = useEnvironments();
  const defaultEnvironment = useDefaultEnvironment();
  const environmentLabel = resolveCatalogEnvironmentLabel({
    environmentId: app.environmentId,
    environments: environmentList?.environments ?? [],
    defaultEnvironmentName: defaultEnvironment.name,
  });

  const segments: { key: string; node: ReactNode }[] = [];
  if (version != null)
    segments.push({ key: "version", node: <span>v{version}</span> });
  segments.push({
    key: "visibility",
    node: <Visibility scope={app.scope} teams={app.teams} />,
  });
  if (environmentLabel)
    segments.push({
      key: "environment",
      node: <span className="truncate">{environmentLabel}</span>,
    });

  return (
    <div className="relative z-10 flex h-7 shrink-0 items-center justify-between gap-2 px-3 text-xs text-muted-foreground shadow-[0_-1px_2px_-1px_rgb(0_0_0/0.08)]">
      <div className="flex min-w-0 items-center gap-1.5">
        {segments.map((segment, index) => (
          <Fragment key={segment.key}>
            {index > 0 && <span className="text-muted-foreground/50">·</span>}
            {segment.node}
          </Fragment>
        ))}
      </div>
      <Link
        href={`/mcp/registry/beta?search=${encodeURIComponent(app.name)}`}
        className="flex shrink-0 items-center gap-1 transition-colors hover:text-foreground hover:underline"
      >
        <Route className="h-3.5 w-3.5" />
        Manage MCP server
      </Link>
    </div>
  );
}

function Visibility({
  scope,
  teams,
}: {
  scope: App["scope"];
  teams: App["teams"];
}) {
  if (scope === "org") {
    return (
      <span className="flex items-center gap-1">
        <Globe className="h-3 w-3" />
        Organization
      </span>
    );
  }
  if (scope === "personal") {
    return (
      <span className="flex items-center gap-1">
        <User className="h-3 w-3" />
        Personal
      </span>
    );
  }
  const names =
    teams && teams.length > 0
      ? teams.map((team) => team.name).join(", ")
      : "Team";
  return (
    <span className="flex min-w-0 items-center gap-1">
      <Users className="h-3 w-3 shrink-0" />
      <span className="truncate">{names}</span>
    </span>
  );
}
