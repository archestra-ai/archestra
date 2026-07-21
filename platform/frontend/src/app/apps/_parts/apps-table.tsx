"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  Loader2,
  MoreHorizontal,
  Pin,
  Server,
  Settings,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AppSettingsDialog } from "@/components/mcp-app/app-settings-dialog";
import { ScopeBadge } from "@/components/scope-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useOpenAppInChat, useOpenExternalAppInChat } from "@/lib/app.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { setPendingProjectChatHandoff } from "@/lib/chat/pending-project-chat-handoff";
import { AppTypeIcon, PinMenuItem } from "./app-card";
import { AppDeleteDialog } from "./app-delete-dialog";

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];
type OwnedApp = Extract<AppListItem, { source: "owned" }>;
type ExternalApp = Extract<AppListItem, { source: "external" }>;

// Table variant of the apps list: one flat table (pinned rows are already
// sorted first by the caller and get a pin marker; the Kind column stands in
// for the owned/external card sections).
export function AppsTable({ apps }: { apps: AppListItem[] }) {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[28%]">Name</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="w-[14%]">Kind</TableHead>
            <TableHead className="w-[16%]">Sharing</TableHead>
            <TableHead className="w-12" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {apps.map((app) =>
            app.source === "owned" ? (
              <OwnedAppRow key={app.id} app={app} />
            ) : (
              <ExternalAppRow
                // Same key rationale as the card grid: several tools of one
                // server can share a widget resource, so the tool-scoped name
                // disambiguates.
                key={`${app.mcpServerId}:${app.resourceUri}:${app.name}`}
                app={app}
              />
            ),
          )}
        </TableBody>
      </Table>
    </div>
  );
}

// === internal components ===

// Shared row chrome: name button that opens the app in a new chat (with an
// inline spinner while the round-trip is in flight), description, kind badge,
// scope cluster, and the overflow menu.
function AppRow({
  app,
  isOpening,
  onOpen,
  kindLabel,
  ownerBadge,
  menuItems,
}: {
  app: AppListItem;
  isOpening: boolean;
  onOpen: () => void;
  kindLabel: string;
  ownerBadge?: React.ReactNode;
  menuItems: React.ReactNode;
}) {
  return (
    <TableRow>
      <TableCell>
        <button
          type="button"
          onClick={onOpen}
          disabled={isOpening}
          aria-label={`Open ${app.name} in new chat`}
          className="flex w-full min-w-0 cursor-pointer items-center gap-2 text-left hover:underline"
        >
          <AppTypeIcon
            owned={app.source === "owned"}
            icon={app.source === "external" ? app.icon : undefined}
          />
          <span className="min-w-0 truncate font-medium">{app.name}</span>
          {isOpening ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            app.pinnedAt && (
              <Pin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )
          )}
        </button>
      </TableCell>
      <TableCell>
        <span className="line-clamp-2 text-muted-foreground">
          {app.description}
        </span>
      </TableCell>
      <TableCell>
        <span className="text-muted-foreground">{kindLabel}</span>
      </TableCell>
      <TableCell>
        <span className="flex flex-wrap items-center gap-1">
          <ScopeBadge
            scope={app.scope}
            teamNames={
              app.source === "owned"
                ? app.teams?.map((team) => team.name)
                : undefined
            }
          />
          {ownerBadge}
        </span>
      </TableCell>
      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="App actions">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">{menuItems}</DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function OwnedAppRow({ app }: { app: OwnedApp }) {
  const router = useRouter();
  const openApp = useOpenAppInChat();
  const { data: canDelete } = useHasPermissions({ app: ["delete"] });
  // Mirrors the card: stays true from click through the redirect; only a
  // failure resets it (the row unmounts on success).
  const [isOpening, setIsOpening] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Same admin-oversight badge as the card: someone else's personal app.
  const isForeignPersonalApp =
    app.scope === "personal" && app.viewerRole === "admin";

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
      <AppRow
        app={app}
        isOpening={isOpening}
        onOpen={handleOpen}
        kindLabel="App"
        ownerBadge={
          isForeignPersonalApp ? (
            <Badge variant="secondary">
              {app.authorName ? `Owned by ${app.authorName}` : "Other user"}
            </Badge>
          ) : undefined
        }
        menuItems={
          <>
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
          </>
        }
      />

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

function ExternalAppRow({ app }: { app: ExternalApp }) {
  const router = useRouter();
  const openApp = useOpenExternalAppInChat();
  const [isOpening, setIsOpening] = useState(false);

  // Standalone run page pinned to this exact install, as on the card.
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
    <AppRow
      app={app}
      isOpening={isOpening}
      onOpen={handleOpen}
      kindLabel="MCP Server App"
      menuItems={
        <>
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
              its standalone page can't render anything useful. */}
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
        </>
      }
    />
  );
}
