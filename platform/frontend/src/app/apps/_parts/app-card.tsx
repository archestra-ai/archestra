"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  AppWindow,
  Loader2,
  MoreHorizontal,
  Pin,
  PinOff,
  Server,
  Settings,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LockedChatIcon } from "@/components/chat/locked-chat-icon";
import { LabelTags } from "@/components/label-tags";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { ScopeBadge } from "@/components/scope-badge";
import { useNavigableCard } from "@/components/table-card-view";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { useHasPermissions } from "@/lib/auth/auth.query";
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

function CardSelectionCheckbox({
  label,
  selection,
  disabled = false,
}: {
  label: string;
  selection?: BulkCardSelectionProps;
  disabled?: boolean;
}) {
  const checkbox = (
    <Checkbox
      className={cn("mt-1", disabled && "pointer-events-none")}
      checked={selection?.selected ?? false}
      onCheckedChange={(value) => selection?.onSelectedChange(!!value)}
      onClick={(event) => {
        event.stopPropagation();
        selection?.onSelectionClick(event);
      }}
      aria-label={label}
      disabled={disabled}
    />
  );

  if (!disabled) return checkbox;

  const reason = "Installed apps are managed through their MCP server";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-not-allowed" title={reason}>
          {checkbox}
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

// Shared card chrome: the scope pill / owner badge / overflow menu cluster that
// sits at the right of the card's header row (mirroring the project card).
function CardOverflowMenu({
  leading,
  children,
}: {
  leading?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {leading}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            aria-label="More actions"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">{children}</DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// Pin/Unpin menu item (mirrors the project card's): pins are per-user and
// toggle from the same overflow menu on both card kinds.
function PinMenuItem({
  pinned,
  target,
}: {
  pinned: boolean;
  target: PinAppTarget;
}) {
  const pinAppMutation = usePinApp();
  return (
    <DropdownMenuItem
      onSelect={() => pinAppMutation.mutate({ pinned: !pinned, target })}
    >
      {pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
      <span>{pinned ? "Unpin" : "Pin"}</span>
    </DropdownMenuItem>
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
  const lockedChatEnabled = useFeature("lockedChatEnabled") ?? false;
  const { data: canDelete } = useHasPermissions({ app: ["delete"] });
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

  const handleOpen = async (lockedChat = false) => {
    setIsOpening(true);
    const result = await openApp.mutateAsync({ appId: app.id, lockedChat });
    if (result?.conversationId) {
      router.push(`/chat/${result.conversationId}`);
    } else {
      setIsOpening(false);
    }
  };
  const navigation = useNavigableCard({
    onNavigate: isOpening ? undefined : () => void handleOpen(),
  });

  return (
    <>
      <Card
        {...navigation.props}
        className={cn(
          "relative flex min-h-[180px] flex-col gap-0 p-4 transition-colors",
          navigation.className,
        )}
      >
        {isOpening ? <CardOpeningOverlay /> : null}

        {/* Header row mirrors the project card: icon + title on one line at the
            left, the scope pill / owner badge / overflow menu at the right. */}
        <div className="mb-1 flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-3">
            {selection ? (
              <CardSelectionCheckbox
                label={`Select ${app.name}`}
                selection={selection}
              />
            ) : null}
            <AppTypeIcon owned icon={app.icon} />
            <button
              type="button"
              className="min-w-0 text-left"
              disabled={isOpening}
              aria-label={`Open ${app.name} in new chat`}
              onClick={() => void handleOpen()}
            >
              <CardTitle className="truncate leading-snug">
                {app.name}
              </CardTitle>
            </button>
          </div>
          <CardOverflowMenu
            leading={
              <>
                <LabelTags labels={app.labels} />
                <ScopeBadge
                  scope={app.scope}
                  teamNames={app.teams?.map((team) => team.name)}
                  userNames={app.users?.map((user) => user.name)}
                />
                {/* A disabled app is author-only, so this badge only ever
                    shows on the author's own card. */}
                {!app.enabled ? (
                  <Badge variant="outline">Disabled</Badge>
                ) : null}
                {app.locked ? <Badge variant="outline">Locked</Badge> : null}
                {/* Between the scope pill and the overflow menu, exactly as the
                    project card places its owner badge. */}
                {isForeignPersonalApp ? (
                  <Badge variant="secondary">
                    {app.authorName
                      ? `Owned by ${app.authorName}`
                      : "Other user"}
                  </Badge>
                ) : null}
              </>
            }
          >
            <PinMenuItem
              pinned={!!app.pinnedAt}
              target={{ source: "owned", appId: app.id }}
            />
            <DropdownMenuItem onSelect={() => onOpenSettings?.(app)}>
              <Settings className="h-4 w-4" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={appRunUrl(app)} target="_blank" rel="noreferrer">
                <SquareArrowOutUpRight className="h-4 w-4" />
                Open in new tab
              </Link>
            </DropdownMenuItem>
            {/* Opening an app is where an app chat is started, so it is where
                the locked-chat choice has to be offered — there is no composer
                to toggle beforehand. Hidden unless the instance has the
                feature on, like the composer's own toggle. */}
            {lockedChatEnabled ? (
              <DropdownMenuItem onSelect={() => void handleOpen(true)}>
                <LockedChatIcon className="h-4 w-4" />
                Open as locked chat
              </DropdownMenuItem>
            ) : null}
            {canDelete ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setDeleteOpen(true)}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </>
            ) : null}
          </CardOverflowMenu>
        </div>

        {app.description ? (
          <CardDescription className="line-clamp-3 break-words">
            {app.description}
          </CardDescription>
        ) : null}
      </Card>

      <AppDeleteDialog
        app={{ id: app.id, name: app.name }}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
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
  // Stays true from click through the redirect; see OwnedAppCard for the same
  // reasoning. Only a failure resets it (the card unmounts on success).
  const [isOpening, setIsOpening] = useState(false);
  const lockedChatEnabled = useFeature("lockedChatEnabled") ?? false;

  // Standalone run page (chrome-less /a namespace, like the owned /a/[appId]),
  // pinned to this exact install for explicit "open in new tab".
  const runHref = `/a/catalog/${app.catalogId}?install=${encodeURIComponent(app.mcpServerId)}&resource=${encodeURIComponent(app.resourceUri)}`;
  const serverHref = `/mcp/registry/${app.catalogId}`;

  const handleOpen = async (lockedChat = false) => {
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
  const navigation = useNavigableCard({
    onNavigate: isOpening ? undefined : () => void handleOpen(),
  });

  return (
    <Card
      {...navigation.props}
      className={cn(
        "relative flex min-h-[180px] flex-col gap-0 p-4 transition-colors",
        navigation.className,
      )}
    >
      {isOpening ? <CardOpeningOverlay /> : null}

      {/* Header row mirrors the project card: icon + title on one line at the
          left, the scope pill / overflow menu at the right. */}
      <div className="mb-1 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-3">
          {showDisabledSelection ? (
            <CardSelectionCheckbox label={`Select ${app.name}`} disabled />
          ) : null}
          <AppTypeIcon owned={false} icon={app.icon} />
          <button
            type="button"
            className="min-w-0 text-left"
            disabled={isOpening}
            aria-label={`Open ${app.name} in new chat`}
            onClick={() => void handleOpen()}
          >
            <CardTitle className="truncate leading-snug">{app.name}</CardTitle>
          </button>
        </div>
        <CardOverflowMenu
          leading={
            <>
              <LabelTags labels={app.labels} />
              <ScopeBadge scope={app.scope} />
            </>
          }
        >
          <PinMenuItem
            pinned={!!app.pinnedAt}
            target={{
              source: "external",
              mcpServerId: app.mcpServerId,
              resourceUri: app.resourceUri,
              toolName: app.toolName,
            }}
          />
          {/* A tool with required inputs only opens via the chat prompt flow —
              its standalone page can't render anything useful, so don't offer it. */}
          {app.requiresInput ? null : (
            <DropdownMenuItem asChild>
              <Link href={runHref} target="_blank" rel="noreferrer">
                <SquareArrowOutUpRight className="h-4 w-4" />
                Open in new tab
              </Link>
            </DropdownMenuItem>
          )}
          {/* Same reasoning as the owned card: opening the app is where the
              app chat is created, so it is where the lock is chosen. */}
          {lockedChatEnabled ? (
            <DropdownMenuItem onSelect={() => void handleOpen(true)}>
              <LockedChatIcon className="h-4 w-4" />
              Open as locked chat
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem asChild>
            <Link href={serverHref}>
              <Server className="h-4 w-4" />
              Manage MCP server
            </Link>
          </DropdownMenuItem>
        </CardOverflowMenu>
      </div>

      {app.description ? (
        <CardDescription className="line-clamp-3 break-words">
          {app.description}
        </CardDescription>
      ) : null}
    </Card>
  );
}
