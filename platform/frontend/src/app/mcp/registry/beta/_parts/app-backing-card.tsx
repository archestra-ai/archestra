"use client";

import { AppWindow, ExternalLink, MessageSquare, Pencil } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import { buildAppChatHandoffUrl } from "@/lib/apps/app-chat-handoff";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useEnvironments } from "@/lib/environment.query";
import { useDefaultEnvironment } from "@/lib/organization.query";
import { resolveCatalogEnvironmentLabel } from "../../_parts/catalog-environment-label";
import { AppSettingsDialog } from "./app-settings-dialog";
import type { CatalogItem } from "./mcp-server-card";

/**
 * Registry card for an owned app's `serverType:"app"` backing. Unlike the
 * install-oriented `McpServerCard`, it carries no install/uninstall/deploy
 * chrome: the body is read-only and all edits (visibility, environment, enabled
 * tools, delete) live behind the top-right pencil, mirroring the regular card.
 */
export function AppBackingCard({ item }: { item: CatalogItem }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const { data: canUpdate } = useHasPermissions({ app: ["update"] });
  const { data: canAdmin } = useHasPermissions({ app: ["admin"] });
  const { data: canTeamAdmin } = useHasPermissions({ app: ["team-admin"] });
  const { data: canDelete } = useHasPermissions({ app: ["delete"] });
  const canManage =
    !!item.appId && (canUpdate || canAdmin || canTeamAdmin || canDelete);

  const { data: environmentList } = useEnvironments();
  const defaultEnvironment = useDefaultEnvironment();
  const environmentLabel = resolveCatalogEnvironmentLabel({
    environmentId: item.environmentId,
    environments: environmentList?.environments ?? [],
    defaultEnvironmentName: defaultEnvironment.name,
  });

  return (
    <Card
      className="flex flex-col relative pt-4 gap-4 h-full"
      data-testid={`app-backing-card-${item.name}`}
    >
      <CardHeader className="gap-0">
        <div className="flex items-start justify-between gap-4 overflow-hidden">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1 overflow-hidden w-full">
              <McpCatalogIcon icon={item.icon} catalogId={item.id} size={20} />
              <TruncatedTooltip content={item.name}>
                <span className="text-lg font-semibold whitespace-nowrap text-ellipsis overflow-hidden">
                  {item.name}
                </span>
              </TruncatedTooltip>
              <Badge variant="secondary" className="shrink-0 gap-1">
                <AppWindow className="h-3 w-3" />
                App
              </Badge>
              {environmentLabel && (
                <Badge
                  variant="outline"
                  className="shrink-0 text-muted-foreground"
                >
                  <span className="max-w-32 truncate">{environmentLabel}</span>
                </Badge>
              )}
            </div>
            {item.description && (
              <p className="text-xs text-muted-foreground line-clamp-2">
                {item.description}
              </p>
            )}
          </div>
          {canManage && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              data-testid={`app-backing-card-settings-${item.name}`}
              aria-label={`Edit ${item.name}`}
              onClick={() => setSettingsOpen(true)}
            >
              <Pencil className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 flex-grow">
        <div className="mt-auto flex flex-col gap-4">
          <div className="flex items-center gap-3 text-sm text-muted-foreground border-t pt-3">
            <ResourceVisibilityBadge
              scope={item.scope}
              teams={item.teams}
              authorId={item.authorId}
              authorName={item.authorName ?? undefined}
              currentUserId={currentUserId}
            />
          </div>
          {item.appId && (
            <div className="flex items-center gap-2">
              <Button asChild variant="outline" size="sm" className="flex-1">
                <Link
                  href={buildAppChatHandoffUrl({
                    appId: item.appId,
                    appName: item.name,
                  })}
                >
                  <MessageSquare className="h-4 w-4" />
                  Chat
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm" className="flex-1">
                <Link
                  href={`/a/${item.appId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink className="h-4 w-4" />
                  Open standalone
                </Link>
              </Button>
            </div>
          )}
        </div>
      </CardContent>
      {canManage && item.appId && (
        <AppSettingsDialog
          appId={item.appId}
          item={item}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      )}
    </Card>
  );
}
