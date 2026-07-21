"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Loader2,
  Pin,
  PinOff,
  Server,
  Settings,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ScopeBadge } from "@/components/scope-badge";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import {
  useOpenAppInChat,
  useOpenExternalAppInChat,
  usePinApp,
} from "@/lib/app.query";
import { setPendingProjectChatHandoff } from "@/lib/chat/pending-project-chat-handoff";
import { AppTypeIcon } from "./app-card";
import { AppDeleteDialog } from "./app-delete-dialog";

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];
type OwnedApp = Extract<AppListItem, { source: "owned" }>;

// Table variant of one apps section (the caller keeps the same Pinned /
// owned / external grouping as the card view). Row click opens the app in a
// new chat, exactly like clicking a card; the actions mirror each card's
// menu, with the type icon distinguishing owned vs MCP-server apps. The
// settings dialog lives on the page (deep-linkable `settings` URL param), so
// the table only reports which app to open it for.
export function AppsTable({
  apps,
  onOpenSettings,
}: {
  apps: AppListItem[];
  onOpenSettings: (app: { id: string }) => void;
}) {
  const router = useRouter();
  const openOwnedApp = useOpenAppInChat();
  const openExternalApp = useOpenExternalAppInChat();
  const pinApp = usePinApp();
  // Row-scoped "Opening…" indicator; mirrors the card overlay. Stays set
  // through the redirect (the table unmounts on success); only a failure
  // resets it.
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [deletingApp, setDeletingApp] = useState<OwnedApp | null>(null);

  const handleOpen = async (app: AppListItem) => {
    if (openingKey) return;
    setOpeningKey(rowKey(app));
    if (app.source === "owned") {
      const result = await openOwnedApp.mutateAsync(app.id);
      if (result?.conversationId) {
        router.push(`/chat/${result.conversationId}`);
        return;
      }
    } else {
      const result = await openExternalApp.mutateAsync({
        mcpServerId: app.mcpServerId,
        resourceUri: app.resourceUri,
      });
      if (result?.conversationId) {
        if (result.mode === "prompt" && result.prompt) {
          setPendingProjectChatHandoff({
            conversationId: result.conversationId,
            prompt: result.prompt,
          });
        }
        router.push(`/chat/${result.conversationId}`);
        return;
      }
    }
    setOpeningKey(null);
  };

  const togglePin = (app: AppListItem) =>
    pinApp.mutate({
      pinned: !app.pinnedAt,
      target:
        app.source === "owned"
          ? { source: "owned", appId: app.id }
          : {
              source: "external",
              mcpServerId: app.mcpServerId,
              resourceUri: app.resourceUri,
              toolName: app.toolName,
            },
    });

  const columns: ColumnDef<AppListItem>[] = [
    {
      id: "name",
      accessorKey: "name",
      header: "App",
      size: 600,
      cell: ({ row }) => {
        const app = row.original;
        const isOpening = openingKey === rowKey(app);
        return (
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <AppTypeIcon
                owned={app.source === "owned"}
                icon={app.source === "external" ? app.icon : undefined}
              />
              <span className="truncate font-medium">{app.name}</span>
              {isOpening && (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
              )}
            </div>
            {app.description && (
              <div className="truncate text-xs text-muted-foreground">
                {app.description}
              </div>
            )}
          </div>
        );
      },
    },
    {
      id: "sharing",
      size: 180,
      header: "Sharing",
      cell: ({ row }) => {
        const app = row.original;
        // Same admin-oversight badge as the card: someone else's personal app.
        const isForeignPersonalApp =
          app.source === "owned" &&
          app.scope === "personal" &&
          app.viewerRole === "admin";
        return (
          <span className="flex flex-wrap items-center gap-1">
            <ScopeBadge
              scope={app.scope}
              teamNames={
                app.source === "owned"
                  ? app.teams?.map((team) => team.name)
                  : undefined
              }
            />
            {isForeignPersonalApp && (
              <Badge variant="secondary">
                {app.authorName ? `Owned by ${app.authorName}` : "Other user"}
              </Badge>
            )}
          </span>
        );
      },
    },
    {
      id: "actions",
      size: 170,
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => {
        const app = row.original;
        const actions: TableRowAction[] = [
          {
            icon: app.pinnedAt ? (
              <PinOff className="h-4 w-4" />
            ) : (
              <Pin className="h-4 w-4" />
            ),
            label: app.pinnedAt ? "Unpin" : "Pin",
            onClick: () => togglePin(app),
          },
          ...(app.source === "owned"
            ? ownedAppActions(app)
            : externalAppActions(app)),
        ];
        return (
          <div className="flex justify-end">
            <TableRowActions actions={actions} />
          </div>
        );
      },
    },
  ];

  const ownedAppActions = (app: OwnedApp): TableRowAction[] => [
    {
      icon: <Settings className="h-4 w-4" />,
      label: "Settings",
      onClick: () => onOpenSettings({ id: app.id }),
    },
    {
      icon: <SquareArrowOutUpRight className="h-4 w-4" />,
      label: "Open in new tab",
      onClick: () => window.open(`/a/${app.id}`, "_blank", "noreferrer"),
    },
    {
      icon: <Trash2 className="h-4 w-4" />,
      label: "Delete",
      variant: "destructive",
      permissions: { app: ["delete"] },
      onClick: () => setDeletingApp(app),
    },
  ];

  const externalAppActions = (
    app: Extract<AppListItem, { source: "external" }>,
  ): TableRowAction[] => [
    // A tool with required inputs only opens via the chat prompt flow — its
    // standalone page can't render anything useful, so don't offer it.
    ...(app.requiresInput
      ? []
      : [
          {
            icon: <SquareArrowOutUpRight className="h-4 w-4" />,
            label: "Open in new tab",
            onClick: () =>
              window.open(
                `/a/catalog/${app.catalogId}?install=${encodeURIComponent(app.mcpServerId)}&resource=${encodeURIComponent(app.resourceUri)}`,
                "_blank",
                "noreferrer",
              ),
          } satisfies TableRowAction,
        ]),
    {
      icon: <Server className="h-4 w-4" />,
      label: "Manage MCP server",
      href: `/mcp/registry/${app.catalogId}`,
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        data={apps}
        getRowId={rowKey}
        onRowClick={(app) => void handleOpen(app)}
        emptyMessage="No apps here yet"
        hidePaginationWhenSinglePage
      />

      {deletingApp && (
        <AppDeleteDialog
          app={{ id: deletingApp.id, name: deletingApp.name }}
          open
          onOpenChange={(open) => {
            if (!open) setDeletingApp(null);
          }}
        />
      )}
    </>
  );
}

// === internal helpers ===

// Same key rationale as the card grid: several tools of one server can share
// a widget resource, so the tool-scoped name disambiguates.
function rowKey(app: AppListItem): string {
  return app.source === "owned"
    ? app.id
    : `${app.mcpServerId}:${app.resourceUri}:${app.name}`;
}
