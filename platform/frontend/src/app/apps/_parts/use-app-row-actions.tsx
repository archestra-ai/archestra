"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  History,
  Server,
  Settings,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { EncryptedChatIcon } from "@/components/chat/encrypted-chat-icon";
import { AppVersionHistoryDialog } from "@/components/mcp-app/app-version-history-dialog";
import type { TableRowAction } from "@/components/table-row-actions";
import { appRunUrl } from "@/lib/apps/app-run-url";
import {
  appActionDisabledReason,
  computeAppAccess,
  useAppAccessContext,
} from "@/lib/apps/use-app-access";
import { useFeature } from "@/lib/config/config.query";
import { AppDeleteDialog } from "./app-delete-dialog";
import { useOpenApp } from "./use-open-app";

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];
type OwnedApp = Extract<AppListItem, { source: "owned" }>;
type ExternalApp = Extract<AppListItem, { source: "external" }>;

/**
 * Every action an app offers besides pinning, shared by its table row and its
 * pinned tile. Render `dialogs` once: it holds the delete and version-history
 * dialogs those actions open.
 */
export function useAppRowActions({
  onOpenSettings,
}: {
  onOpenSettings: (app: { id: string }) => void;
}): {
  actionsFor: (app: AppListItem) => TableRowAction[];
  dialogs: ReactNode;
} {
  const { open } = useOpenApp();
  const accessContext = useAppAccessContext();
  const encryptedChatEnabled = useFeature("encryptedChatEnabled") ?? false;
  const [deletingApp, setDeletingApp] = useState<OwnedApp | null>(null);
  const [historyApp, setHistoryApp] = useState<OwnedApp | null>(null);

  const encryptedChatAction = (app: AppListItem): TableRowAction[] =>
    encryptedChatEnabled
      ? [
          {
            icon: <EncryptedChatIcon className="h-4 w-4" />,
            label: "Open as encrypted chat",
            onClick: () => void open(app, { encryptedChat: true }),
          },
        ]
      : [];

  const ownedAppActions = (app: OwnedApp): TableRowAction[] => {
    const access = computeAppAccess(app, accessContext);
    const settingsDisabledReason = appActionDisabledReason({
      app,
      access,
      action: "update",
    });
    const deleteDisabledReason = appActionDisabledReason({
      app,
      access,
      action: "delete",
    });
    return [
      {
        icon: <Settings className="h-4 w-4" />,
        label: "Settings",
        permissions: { app: ["update"] },
        permissionScope: app.id,
        disabled: !!settingsDisabledReason,
        disabledTooltip: settingsDisabledReason,
        onClick: () => onOpenSettings({ id: app.id }),
      },
      {
        icon: <History className="h-4 w-4" />,
        label: "Version history",
        permissions: { app: ["update"] },
        permissionScope: app.id,
        disabled: !!settingsDisabledReason,
        disabledTooltip: settingsDisabledReason,
        onClick: () => setHistoryApp(app),
      },
      {
        icon: <SquareArrowOutUpRight className="h-4 w-4" />,
        label: "Open in new tab",
        href: appRunUrl(app),
        external: true,
      },
      ...encryptedChatAction(app),
      {
        icon: <Trash2 className="h-4 w-4" />,
        label: "Delete",
        permissions: { app: ["delete"] },
        permissionScope: app.id,
        disabled: !!deleteDisabledReason,
        disabledTooltip: deleteDisabledReason,
        variant: "destructive" as const,
        onClick: () => setDeletingApp(app),
      },
    ];
  };

  const externalAppActions = (app: ExternalApp): TableRowAction[] => [
    // A tool with required inputs only opens via the chat prompt flow — its
    // standalone page can't render anything useful, so don't offer it.
    ...(app.requiresInput
      ? []
      : [
          {
            icon: <SquareArrowOutUpRight className="h-4 w-4" />,
            label: "Open in new tab",
            href: externalAppRunUrl(app),
            external: true,
          } satisfies TableRowAction,
        ]),
    ...encryptedChatAction(app),
    {
      icon: <Server className="h-4 w-4" />,
      label: "Manage MCP server",
      href: `/mcp/registry/${app.catalogId}`,
    },
  ];

  const actionsFor = (app: AppListItem): TableRowAction[] =>
    app.source === "owned" ? ownedAppActions(app) : externalAppActions(app);

  const dialogs = (
    <>
      {deletingApp ? (
        <AppDeleteDialog
          app={{ id: deletingApp.id, name: deletingApp.name }}
          open
          onOpenChange={(open) => {
            if (!open) setDeletingApp(null);
          }}
        />
      ) : null}
      {historyApp ? (
        <AppVersionHistoryDialog
          app={historyApp}
          open
          onOpenChange={(open) => {
            if (!open) setHistoryApp(null);
          }}
        />
      ) : null}
    </>
  );

  return { actionsFor, dialogs };
}

// Standalone run page (chrome-less /a namespace, like the owned /a/[appId]),
// pinned to this exact install.
export function externalAppRunUrl(app: ExternalApp): string {
  return `/a/catalog/${app.catalogId}?install=${encodeURIComponent(app.mcpServerId)}&resource=${encodeURIComponent(app.resourceUri)}`;
}
