"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  AppWindow,
  History,
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
import { LockedChatIcon } from "@/components/chat/locked-chat-icon";
import { CreatedByCell } from "@/components/created-by-cell";
import { LabelTags } from "@/components/label-tags";
import { AppVersionHistoryDialog } from "@/components/mcp-app/app-version-history-dialog";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { ScopeBadge } from "@/components/scope-badge";
import { TableCard } from "@/components/table-card-view";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type PinAppTarget,
  useOpenAppInChat,
  useOpenExternalAppInChat,
  usePinApp,
} from "@/lib/app.query";
import { appRunUrl } from "@/lib/apps/app-run-url";
import {
  appActionDisabledReason,
  useAppAccess,
} from "@/lib/apps/use-app-access";
import { setPendingProjectChatHandoff } from "@/lib/chat/pending-project-chat-handoff";
import { useFeature } from "@/lib/config/config.query";
import type { BulkCardSelectionProps } from "@/lib/hooks/use-bulk-card-selection";
import { cn } from "@/lib/utils";
import { AppDeleteDialog } from "./app-delete-dialog";

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];
type OwnedApp = Extract<AppListItem, { source: "owned" }>;
type ExternalApp = Extract<AppListItem, { source: "external" }>;

export function AppCard({
  app,
  onOpenSettings,
  selection,
}: {
  app: AppListItem;
  // The settings dialog (and its URL param) lives at the list level, so the
  // card only reports which app to open it for.
  onOpenSettings?: (app: OwnedApp) => void;
  /** `null` renders the disabled external-app selection control. */
  selection?: BulkCardSelectionProps | null;
}) {
  return app.source === "owned" ? (
    <OwnedAppCard
      app={app}
      onOpenSettings={onOpenSettings}
      selection={selection ?? undefined}
    />
  ) : (
    <ExternalAppCard app={app} showDisabledSelection={selection === null} />
  );
}

// Opening is a round-trip; while it's in flight show a loading overlay so the
// card doesn't look frozen. Visual only (pointer-events-none). Shared by both
// card kinds since both open into chat the same way.
function CardOpeningOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center rounded-xl bg-background/70 backdrop-blur-[1px]">
      <span
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          "shadow-sm",
        )}
      >
        <Loader2 className="animate-spin" />
        Opening…
      </span>
    </div>
  );
}

// The app's leading icon (shared by cards and table rows): the icon set on the
// app itself, or — for an external app — its backing MCP server's registry one,
// both emoji or image. Without one, the glyph says which kind of app it is: the
// app window for an owned app, the server glyph for an external one. The label
// (what "owned" vs "external" means) rides in the tooltip + aria-label rather
// than a separate badge.
export function AppTypeIcon({
  owned,
  icon,
}: {
  owned: boolean;
  icon?: string | null;
}) {
  const label = owned ? "MCP app" : "MCP server app";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          className="inline-flex text-muted-foreground"
        >
          <McpCatalogIcon
            icon={icon}
            size={16}
            fallback={owned ? AppWindow : undefined}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// Clicking the guarded card shell opens the app in a new chat. The backend
// seeds a conversation with the app already rendered and returns its id, so we
// navigate straight to it (no model turn).
function OwnedAppCard({
  app,
  onOpenSettings,
  selection,
}: {
  app: OwnedApp;
  onOpenSettings?: (app: OwnedApp) => void;
  selection?: BulkCardSelectionProps;
}) {
  const router = useRouter();
  const openApp = useOpenAppInChat();
  const pinApp = usePinApp();
  const lockedChatEnabled = useFeature("lockedChatEnabled") ?? false;
  const access = useAppAccess(app);
  // A personal app the caller only reaches through app:admin oversight
  // (viewerRole "admin") — i.e. someone else's personal app — gets a visible
  // "Owned by <name>" badge (mirroring the Projects page) so an admin can tell
  // it apart from their own personal apps at a glance, without hovering the
  // icon-only scope pill. The server computes viewerRole from the real access
  // path, so a still-loading session can never mislabel the viewer's own app.
  const isForeignPersonalApp =
    app.scope === "personal" && app.viewerRole === "admin";
  // Stays true from click through the redirect: the mutation resolving flips
  // isPending off before navigation paints, so spin on this instead. On success
  // the card unmounts mid-navigation, so it never resets; only a failure does.
  const [isOpening, setIsOpening] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
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

  const handleOpen = async (lockedChat = false) => {
    if (isOpening) return;
    setIsOpening(true);
    const result = await openApp.mutateAsync({ appId: app.id, lockedChat });
    if (result?.conversationId) {
      router.push(`/chat/${result.conversationId}`);
    } else {
      setIsOpening(false);
    }
  };
  const actions: TableRowAction[] = [
    {
      icon: <Settings className="h-4 w-4" />,
      label: "Settings",
      permissions: { app: ["update"] },
      disabled: !!settingsDisabledReason,
      disabledTooltip: settingsDisabledReason,
      onClick: () => onOpenSettings?.(app),
    },
  ];
  const dropdownActions: TableRowAction[] = [
    {
      icon: app.pinnedAt ? (
        <PinOff className="h-4 w-4" />
      ) : (
        <Pin className="h-4 w-4" />
      ),
      label: app.pinnedAt ? "Unpin" : "Pin",
      onClick: () =>
        pinApp.mutate({
          pinned: !app.pinnedAt,
          target: { source: "owned", appId: app.id } satisfies PinAppTarget,
        }),
    },
    {
      icon: <History className="h-4 w-4" />,
      label: "Version history",
      permissions: { app: ["update"] },
      disabled: !!settingsDisabledReason,
      disabledTooltip: settingsDisabledReason,
      onClick: () => setHistoryOpen(true),
    },
    {
      icon: <SquareArrowOutUpRight className="h-4 w-4" />,
      label: "Open in new tab",
      href: appRunUrl(app),
      external: true,
    },
    ...(lockedChatEnabled
      ? [
          {
            icon: <LockedChatIcon className="h-4 w-4" />,
            label: "Open as locked chat",
            onClick: () => void handleOpen(true),
          } satisfies TableRowAction,
        ]
      : []),
    {
      icon: <Trash2 className="h-4 w-4" />,
      label: "Delete",
      variant: "destructive",
      permissions: { app: ["delete"] },
      disabled: !!deleteDisabledReason,
      disabledTooltip: deleteDisabledReason,
      onClick: () => setDeleteOpen(true),
    },
  ];
  return (
    <>
      <TableCard
        className="relative"
        icon={<AppTypeIcon owned icon={app.icon} />}
        title={
          <span className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              className="truncate text-left"
              disabled={isOpening}
              aria-label={`Open ${app.name} in new chat`}
              onClick={() => void handleOpen()}
            >
              {app.name}
            </button>
            <LabelTags labels={app.labels} />
          </span>
        }
        description={app.description}
        actions={
          <TableRowActions
            actions={actions}
            dropdownActions={dropdownActions}
            itemName={app.name}
          />
        }
        selected={selection?.selected}
        selectionDisabled={selection?.selectionDisabled || !access.canEdit}
        selectionDisabledTooltip={
          settingsDisabledReason ??
          "You do not have permission to modify this app"
        }
        onSelectedChange={selection?.onSelectedChange}
        onSelectionClick={selection?.onSelectionClick}
        selectionLabel={selection ? `Select ${app.name}` : undefined}
        onNavigate={isOpening ? undefined : () => void handleOpen()}
        footer={
          <CreatedByCell
            createdBy={app.createdBy}
            className="text-xs text-muted-foreground"
          />
        }
      >
        {isOpening ? <CardOpeningOverlay /> : null}
        <div className="flex flex-wrap items-center gap-2">
          <ScopeBadge
            scope={app.scope}
            teamNames={app.teams?.map((team) => team.name)}
            userNames={app.users?.map((user) => user.name)}
            showLabel
          />
          {!app.enabled ? <Badge variant="outline">Disabled</Badge> : null}
          {app.locked ? <Badge variant="outline">Locked</Badge> : null}
          {isForeignPersonalApp ? (
            <Badge variant="secondary">
              {app.authorName ? `Owned by ${app.authorName}` : "Other user"}
            </Badge>
          ) : null}
        </div>
      </TableCard>

      <AppDeleteDialog
        app={{ id: app.id, name: app.name }}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
      <AppVersionHistoryDialog
        app={app}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
      />
    </>
  );
}

// External MCP-server apps open in chat like owned apps: clicking creates a
// conversation and navigates to it. When the app's tool needs no inputs the
// backend seeds the UI already rendered against this install; when it has
// required inputs the backend returns an opening prompt instead, which rides
// the pending-chat handoff so `/chat/<id>` sends it as the first user message —
// the agent asks for the inputs, calls the tool, and the result mounts the app.
// Each card is one concrete install (only accessible installs are listed), so
// the whole card is always a click target. The title is the server's catalog
// display name, "/ <tool>"-suffixed (short tool name, never the slug prefix)
// only when the server exposes several UI tools.
function ExternalAppCard({
  app,
  showDisabledSelection,
}: {
  app: ExternalApp;
  showDisabledSelection: boolean;
}) {
  const router = useRouter();
  const openApp = useOpenExternalAppInChat();
  const pinApp = usePinApp();
  // Stays true from click through the redirect; see OwnedAppCard for the same
  // reasoning. Only a failure resets it (the card unmounts on success).
  const [isOpening, setIsOpening] = useState(false);
  const lockedChatEnabled = useFeature("lockedChatEnabled") ?? false;

  // Standalone run page (chrome-less /a namespace, like the owned /a/[appId]),
  // pinned to this exact install for explicit "open in new tab".
  const runHref = `/a/catalog/${app.catalogId}?install=${encodeURIComponent(app.mcpServerId)}&resource=${encodeURIComponent(app.resourceUri)}`;
  const serverHref = `/mcp/registry/${app.catalogId}`;

  const handleOpen = async (lockedChat = false) => {
    if (isOpening) return;
    setIsOpening(true);
    const result = await openApp.mutateAsync({
      mcpServerId: app.mcpServerId,
      resourceUri: app.resourceUri,
      lockedChat,
    });
    if (result?.conversationId) {
      if (result.mode === "prompt" && result.prompt) {
        setPendingProjectChatHandoff({
          conversationId: result.conversationId,
          prompt: result.prompt,
        });
      }
      router.push(`/chat/${result.conversationId}`);
    } else {
      setIsOpening(false);
    }
  };
  const actions: TableRowAction[] = [
    {
      icon: <Server className="h-4 w-4" />,
      label: "Manage MCP server",
      href: serverHref,
    },
  ];
  const dropdownActions: TableRowAction[] = [
    {
      icon: app.pinnedAt ? (
        <PinOff className="h-4 w-4" />
      ) : (
        <Pin className="h-4 w-4" />
      ),
      label: app.pinnedAt ? "Unpin" : "Pin",
      onClick: () =>
        pinApp.mutate({
          pinned: !app.pinnedAt,
          target: {
            source: "external",
            mcpServerId: app.mcpServerId,
            resourceUri: app.resourceUri,
            toolName: app.toolName,
          } satisfies PinAppTarget,
        }),
    },
    ...(app.requiresInput
      ? []
      : [
          {
            icon: <SquareArrowOutUpRight className="h-4 w-4" />,
            label: "Open in new tab",
            href: runHref,
            external: true,
          } satisfies TableRowAction,
        ]),
    ...(lockedChatEnabled
      ? [
          {
            icon: <LockedChatIcon className="h-4 w-4" />,
            label: "Open as locked chat",
            onClick: () => void handleOpen(true),
          } satisfies TableRowAction,
        ]
      : []),
  ];
  return (
    <TableCard
      className="relative"
      icon={<AppTypeIcon owned={false} icon={app.icon} />}
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            className="truncate text-left"
            disabled={isOpening}
            aria-label={`Open ${app.name} in new chat`}
            onClick={() => void handleOpen()}
          >
            {app.name}
          </button>
          <LabelTags labels={app.labels} />
        </span>
      }
      description={app.description}
      actions={
        <TableRowActions
          actions={actions}
          dropdownActions={dropdownActions}
          itemName={app.name}
        />
      }
      selected={false}
      selectionDisabled={showDisabledSelection}
      selectionDisabledTooltip="Installed apps are managed through their MCP server"
      onSelectedChange={showDisabledSelection ? () => undefined : undefined}
      selectionLabel={showDisabledSelection ? `Select ${app.name}` : undefined}
      onNavigate={isOpening ? undefined : () => void handleOpen()}
    >
      {isOpening ? <CardOpeningOverlay /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <ScopeBadge scope={app.scope} showLabel />
      </div>
    </TableCard>
  );
}
