"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { AppWindow, Loader2 } from "lucide-react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { type PinnedTile, PinnedTiles } from "@/components/pinned-tiles";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { usePinApp } from "@/lib/app.query";
import { appRunUrl } from "@/lib/apps/app-run-url";
import { pinTarget } from "./apps-table";
import { externalAppRunUrl, useAppRowActions } from "./use-app-row-actions";
import { getAppRowKey, useOpenApp } from "./use-open-app";

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];

/**
 * The apps the viewer pinned, as tiles above the table. Open starts a new chat
 * with the app in it, as clicking its row does; the tile itself links to the
 * app's standalone page. Its "More actions" menu holds everything its table
 * row offers except pinning, which the tile has its own control for.
 */
export function AppPinnedTiles({
  apps,
  onOpenSettings,
}: {
  /** Pinned apps, newest pin first. */
  apps: AppListItem[];
  onOpenSettings: (app: { id: string }) => void;
}) {
  const { open, openingKey } = useOpenApp();
  const pinApp = usePinApp();
  const { actionsFor, dialogs } = useAppRowActions({ onOpenSettings });

  const tiles: PinnedTile[] = apps.map((app) => {
    const key = getAppRowKey(app);
    const isOpening = openingKey === key;
    return {
      id: key,
      name: app.name,
      href: tileHref(app),
      icon: (
        <McpCatalogIcon
          icon={app.iconUrl ?? app.icon}
          size={18}
          fallback={app.source === "owned" ? AppWindow : undefined}
        />
      ),
      status:
        app.description ??
        (app.source === "owned" ? "App" : "From an installed MCP server"),
      kind: <AppKindChip app={app} />,
      action: (
        <Button
          size="sm"
          disabled={!!openingKey}
          onClick={() => void open(app)}
          aria-label={`Open ${app.name} in new chat`}
        >
          {isOpening ? <Loader2 className="animate-spin" /> : null}
          <span>Open</span>
        </Button>
      ),
      menu: (
        <TableRowActions
          itemName={app.name}
          permissionScope={app.source === "owned" ? app.id : undefined}
          actions={[]}
          dropdownActions={actionsFor(app)}
        />
      ),
      onUnpin: () => pinApp.mutate({ pinned: false, target: pinTarget(app) }),
    };
  });

  return (
    <>
      <PinnedTiles tiles={tiles} />
      {dialogs}
    </>
  );
}

// The standalone run page. A tool that needs inputs has none it can render,
// so its tile leads to the MCP server that provides it.
function tileHref(app: AppListItem): string {
  if (app.source === "owned") return appRunUrl(app);
  return app.requiresInput
    ? `/mcp/registry/${app.catalogId}`
    : externalAppRunUrl(app);
}

function AppKindChip({ app }: { app: AppListItem }) {
  if (app.source === "external") {
    return <Badge variant="outline">MCP server app</Badge>;
  }
  return app.enabled ? null : <Badge variant="outline">Disabled</Badge>;
}
