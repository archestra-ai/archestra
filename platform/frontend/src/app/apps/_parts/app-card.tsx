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
import { AppSettingsDialog } from "@/components/mcp-app/app-settings-dialog";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { ScopeBadge } from "@/components/scope-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
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
import { useHasPermissions } from "@/lib/auth/auth.query";
import { setPendingProjectChatHandoff } from "@/lib/chat/pending-project-chat-handoff";
import { cn } from "@/lib/utils";
import { AppDeleteDialog } from "./app-delete-dialog";

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];
type OwnedApp = Extract<AppListItem, { source: "owned" }>;
type ExternalApp = Extract<AppListItem, { source: "external" }>;

export function AppCard({ app }: { app: AppListItem }) {
  return app.source === "owned" ? (
    <OwnedAppCard app={app} />
  ) : (
    <ExternalAppCard app={app} />
  );
}

// Shared card chrome: a full-card click target (rendered by the caller) sits
// behind the content, and the overflow menu floats above it (z-10) so its own
// clicks don't fall through to the card action.
function CardOverflowMenu({
  leading,
  children,
}: {
  leading?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="absolute right-2 top-2 z-10 flex items-center gap-1.5">
      {leading}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            onClick={(e) => e.stopPropagation()}
            aria-label="More actions"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          {children}
        </DropdownMenuContent>
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
      {pinned ? "Unpin" : "Pin"}
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

// The app's type, as the leading icon. External cards show the backing MCP
// server's registry icon (emoji or image) when the catalog has one;
// McpCatalogIcon falls back to the same generic Server glyph otherwise. The
// label (what "owned" vs "external" means) rides in the tooltip + aria-label
// rather than a separate badge. Lifted above the full-card click button so it
// can be hovered.
function AppTypeIcon({
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
          className="relative z-10 inline-flex text-muted-foreground"
        >
          {owned ? (
            <AppWindow className="h-4 w-4" />
          ) : (
            <McpCatalogIcon icon={icon} size={16} />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// Clicking the card opens the app in a new chat; the overlay button covers the
// whole card. The backend seeds a conversation with the app already rendered and
// returns its id, so we navigate straight to it (no model turn).
function OwnedAppCard({ app }: { app: OwnedApp }) {
  const router = useRouter();
  const openApp = useOpenAppInChat();
  const { data: canDelete } = useHasPermissions({ app: ["delete"] });
  // Stays true from click through the redirect: the mutation resolving flips
  // isPending off before navigation paints, so spin on this instead. On success
  // the card unmounts mid-navigation, so it never resets; only a failure does.
  const [isOpening, setIsOpening] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const handleOpen = async () => {
    setIsOpening(true);
    const result = await openApp.mutateAsync(app.id);
    if (result?.conversationId) {
      router.push(`/chat/${result.conversationId}`);
    } else {
      setIsOpening(false);
    }
  };

  return (
    <>
      <Card className="relative flex min-h-[180px] cursor-pointer flex-col gap-0 p-4 transition-all hover:border-primary hover:bg-muted/40 hover:shadow-md">
        <button
          type="button"
          onClick={handleOpen}
          disabled={isOpening}
          className="absolute inset-0 rounded-xl"
          aria-label={`Open ${app.name} in new chat`}
        />

        {isOpening ? <CardOpeningOverlay /> : null}

        <CardOverflowMenu
          leading={
            <ScopeBadge
              scope={app.scope}
              teamNames={app.teams?.map((team) => team.name)}
              hidePersonal
            />
          }
        >
          <PinMenuItem
            pinned={!!app.pinnedAt}
            target={{ source: "owned", appId: app.id }}
          />
          <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
            <Settings className="h-4 w-4" />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/a/${app.id}`} target="_blank" rel="noreferrer">
              <SquareArrowOutUpRight className="h-4 w-4" />
              Open in new tab
            </Link>
          </DropdownMenuItem>
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

        <div className="mb-3 flex items-center gap-1.5 pr-16">
          <AppTypeIcon owned />
        </div>

        <CardTitle className="line-clamp-2 leading-snug break-words">
          {app.name}
        </CardTitle>
        {app.description ? (
          <CardDescription className="mt-1 line-clamp-3 break-words">
            {app.description}
          </CardDescription>
        ) : null}
      </Card>

      <AppDeleteDialog
        app={{ id: app.id, name: app.name }}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />

      <AppSettingsDialog
        appId={app.id}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
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
// the whole card is always a click target. The title is the chat-style
// "<server> / <tool>" label (the catalog display name, never the slug prefix).
function ExternalAppCard({ app }: { app: ExternalApp }) {
  const router = useRouter();
  const openApp = useOpenExternalAppInChat();
  // Stays true from click through the redirect; see OwnedAppCard for the same
  // reasoning. Only a failure resets it (the card unmounts on success).
  const [isOpening, setIsOpening] = useState(false);

  // Standalone run page (chrome-less /a namespace, like the owned /a/[appId]),
  // pinned to this exact install for explicit "open in new tab".
  const runHref = `/a/catalog/${app.catalogId}?install=${encodeURIComponent(app.mcpServerId)}&resource=${encodeURIComponent(app.resourceUri)}`;
  const serverHref = `/mcp/registry/${app.catalogId}`;

  const handleOpen = async () => {
    setIsOpening(true);
    const result = await openApp.mutateAsync({
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
    } else {
      setIsOpening(false);
    }
  };

  return (
    <Card className="relative flex min-h-[180px] cursor-pointer flex-col gap-0 p-4 transition-all hover:border-primary hover:bg-muted/40 hover:shadow-md">
      <button
        type="button"
        onClick={handleOpen}
        disabled={isOpening}
        className="absolute inset-0 rounded-xl"
        aria-label={`Open ${app.name} in new chat`}
      />

      {isOpening ? <CardOpeningOverlay /> : null}

      <CardOverflowMenu leading={<ScopeBadge scope={app.scope} hidePersonal />}>
        <PinMenuItem
          pinned={!!app.pinnedAt}
          target={{
            source: "external",
            mcpServerId: app.mcpServerId,
            resourceUri: app.resourceUri,
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
        <DropdownMenuItem asChild>
          <Link href={serverHref}>
            <Server className="h-4 w-4" />
            Manage MCP server
          </Link>
        </DropdownMenuItem>
      </CardOverflowMenu>

      <div className="mb-3 flex items-center gap-1.5 pr-16">
        <AppTypeIcon owned={false} icon={app.icon} />
      </div>

      <CardTitle className="line-clamp-2 leading-snug break-words">
        {app.name}
      </CardTitle>
      {app.description ? (
        <CardDescription className="mt-1 line-clamp-3 break-words">
          {app.description}
        </CardDescription>
      ) : null}
    </Card>
  );
}
