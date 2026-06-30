"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  AppWindow,
  ExternalLink,
  Globe,
  Loader2,
  MoreHorizontal,
  Server,
  Trash2,
  User,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ResourceVisibilityBadge,
  scopeStyles,
} from "@/components/resource-visibility-badge";
import { Badge } from "@/components/ui/badge";
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
import { useOpenAppInChat, useOpenExternalAppInChat } from "@/lib/app.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { cn } from "@/lib/utils";
import { AppDeleteDialog } from "./app-delete-dialog";

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];
type OwnedApp = Extract<AppListItem, { source: "owned" }>;
type ExternalApp = Extract<AppListItem, { source: "external" }>;

export function AppCard({
  app,
  currentUserId,
}: {
  app: AppListItem;
  currentUserId: string | undefined;
}) {
  return app.source === "owned" ? (
    <OwnedAppCard app={app} currentUserId={currentUserId} />
  ) : (
    <ExternalAppCard app={app} />
  );
}

// Shared card chrome: a full-card click target (rendered by the caller) sits
// behind the content, and the overflow menu floats above it (z-10) so its own
// clicks don't fall through to the card action.
function CardOverflowMenu({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute right-2 top-2 z-10">
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

// An external app card lists one concrete install, so it carries a scope chip
// (Personal/Team/Org) to disambiguate sibling installs of the same server.
const SCOPE_BADGE: Record<
  ExternalApp["scope"],
  { label: string; icon: typeof User }
> = {
  personal: { label: "Personal", icon: User },
  team: { label: "Team", icon: Users },
  org: { label: "Organization", icon: Globe },
};

// Icon-only scope pill (label rides in the tooltip + aria-label), matching the
// projects-card visibility pill so personal/team/org reads identically across
// surfaces. Stays inline in the metadata row, alongside the "MCP server" badge.
function ExternalAppScopeBadge({ scope }: { scope: ExternalApp["scope"] }) {
  const { label, icon: Icon } = SCOPE_BADGE[scope];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          aria-label={label}
          className={cn(scopeStyles[scope], "px-1.5")}
        >
          <Icon className="h-3 w-3" />
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// Clicking the card opens the app in a new chat; the overlay button covers the
// whole card. The backend seeds a conversation with the app already rendered and
// returns its id, so we navigate straight to it (no model turn).
function OwnedAppCard({
  app,
  currentUserId,
}: {
  app: OwnedApp;
  currentUserId: string | undefined;
}) {
  const router = useRouter();
  const openApp = useOpenAppInChat();
  const { data: canDelete } = useHasPermissions({ app: ["delete"] });
  // Stays true from click through the redirect: the mutation resolving flips
  // isPending off before navigation paints, so spin on this instead. On success
  // the card unmounts mid-navigation, so it never resets; only a failure does.
  const [isOpening, setIsOpening] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

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

        <CardOverflowMenu>
          <DropdownMenuItem asChild>
            <Link href={`/a/${app.id}`} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" />
              Open in new tab
            </Link>
          </DropdownMenuItem>
          {canDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={(e) => {
                  e.preventDefault();
                  setDeleteOpen(true);
                }}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </>
          ) : null}
        </CardOverflowMenu>

        <div className="mb-3 flex flex-wrap items-center gap-1.5 pr-8">
          <AppWindow className="h-4 w-4 shrink-0 text-muted-foreground" />
          <ResourceVisibilityBadge
            scope={app.scope}
            teams={undefined}
            authorId={app.authorId}
            authorName={undefined}
            currentUserId={currentUserId}
          />
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
    </>
  );
}

// External MCP-server apps open in chat exactly like owned apps: clicking seeds
// a conversation with the UI rendered against this install and navigates to it.
// Each card is one concrete install (only accessible installs are listed), so
// the whole card is always a click target. The title is the chat-style
// "<server> / <tool>" label (the catalog display name, never the slug prefix).
function ExternalAppCard({ app }: { app: ExternalApp }) {
  const router = useRouter();
  const openApp = useOpenExternalAppInChat();
  // Stays true from click through the redirect; see OwnedAppCard for the same
  // reasoning. Only a failure resets it (the card unmounts on success).
  const [isOpening, setIsOpening] = useState(false);

  // Run page pinned to this exact install for explicit "open in new tab".
  const runHref = `/apps/catalog/${app.catalogId}/run?install=${encodeURIComponent(app.mcpServerId)}&resource=${encodeURIComponent(app.resourceUri)}`;
  const serverHref = `/mcp/registry/beta/${app.catalogId}`;

  const handleOpen = async () => {
    setIsOpening(true);
    const result = await openApp.mutateAsync({
      mcpServerId: app.mcpServerId,
      resourceUri: app.resourceUri,
    });
    if (result?.conversationId) {
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

      <CardOverflowMenu>
        <DropdownMenuItem asChild>
          <Link href={runHref} target="_blank" rel="noreferrer">
            <ExternalLink className="h-4 w-4" />
            Open in new tab
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={serverHref}>
            <Server className="h-4 w-4" />
            Manage MCP server
          </Link>
        </DropdownMenuItem>
      </CardOverflowMenu>

      <div className="mb-3 flex flex-wrap items-center gap-1.5 pr-8">
        <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
        <Badge variant="outline" className="gap-1 text-xs">
          MCP server
        </Badge>
        <ExternalAppScopeBadge scope={app.scope} />
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
