"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  AppWindow,
  Download,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Server,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
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
import { useOpenAppInChat } from "@/lib/app.query";
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

        {/* Opening is a round-trip; while it's in flight show a loading overlay so
            the card doesn't look frozen. It's visual only (pointer-events-none). */}
        {isOpening ? (
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
        ) : null}

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

// External UI-providing apps open the standalone run page for their specific
// `ui://` resource, or route to the MCP server page when the caller has no
// accessible install. The title is the chat-style "<server> / <tool>" label
// (the catalog display name, never the slug prefix).
function ExternalAppCard({ app }: { app: ExternalApp }) {
  const runHref = `/apps/catalog/${app.catalogId}/run?resource=${encodeURIComponent(app.resourceUri)}`;
  const serverHref = `/mcp/registry/beta/${app.catalogId}`;

  return (
    <Card
      className={cn(
        "relative flex min-h-[180px] flex-col gap-0 p-4 transition-all",
        // Only a runnable app is a click target; an uninstalled one offers a
        // footer CTA instead, so it gets no whole-card link or hover affordance.
        app.runnable &&
          "cursor-pointer hover:border-primary hover:bg-muted/40 hover:shadow-md",
      )}
    >
      {app.runnable ? (
        <Link
          href={runHref}
          className="absolute inset-0 rounded-xl"
          aria-label={`Open ${app.name}`}
        />
      ) : null}

      {/* An uninstalled app has only the install CTA below, so it gets no menu. */}
      {app.runnable ? (
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
      ) : null}

      <div
        className={cn(
          "mb-3 flex flex-wrap items-center gap-1.5",
          app.runnable && "pr-8",
        )}
      >
        <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
        <Badge variant="outline" className="gap-1 text-xs">
          MCP server
        </Badge>
      </div>

      <CardTitle className="line-clamp-2 leading-snug break-words">
        {app.name}
      </CardTitle>
      {app.description ? (
        <CardDescription className="mt-1 line-clamp-3 break-words">
          {app.description}
        </CardDescription>
      ) : null}

      {app.runnable ? null : (
        <div className="mt-auto pt-3">
          <Link
            href={serverHref}
            className="relative z-10 inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
          >
            <Download className="h-3.5 w-3.5" />
            Install MCP server to run
          </Link>
        </div>
      )}
    </Card>
  );
}
