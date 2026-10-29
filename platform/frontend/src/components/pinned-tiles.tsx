"use client";

import { Pin } from "lucide-react";
import type { ReactNode } from "react";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface PinnedTile {
  id: string;
  name: string;
  href: string;
  icon: ReactNode;
  /** One line under the name: last used, running, needs setup. */
  status?: ReactNode;
  /** The kind of thing it is, e.g. "Claude Code". */
  kind?: ReactNode;
  /** Why it is pinned for you, when you did not pin it yourself. */
  pinnedBecause?: string[];
  /** The one action that matters for it, e.g. Chat or Start run. */
  action?: ReactNode;
  /** Unpins it. Unset for a tile pinned automatically. */
  onUnpin?: () => void;
  /** Everything else it offers, as a "More actions" menu at the top right. */
  menu?: ReactNode;
}

/**
 * The pinned items of a list page, as tiles above its table. Every tile has
 * the same three parts in the same place — name and status, then kind and
 * why-pinned chips, then one action — so a row of them reads evenly whatever
 * each one holds.
 */
export function PinnedTiles({
  tiles,
  isLoading = false,
}: {
  tiles: PinnedTile[];
  isLoading?: boolean;
}) {
  if (!isLoading && tiles.length === 0) return null;
  return (
    <section aria-labelledby="pinned-tiles" className="space-y-3">
      <h2
        id="pinned-tiles"
        className="text-sm font-medium uppercase tracking-wide text-muted-foreground"
      >
        Pinned
      </h2>
      {/* `minmax(0, 1fr)` columns and `min-w-0` tiles: long text truncates
          inside its tile instead of widening the column past the page. */}
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[repeat(2,minmax(0,1fr))] lg:grid-cols-[repeat(3,minmax(0,1fr))] xl:grid-cols-[repeat(4,minmax(0,1fr))]">
        {isLoading && tiles.length === 0
          ? [0, 1, 2].map((index) => (
              <li key={index}>
                <Skeleton className="h-32 rounded-xl" />
              </li>
            ))
          : tiles.map((tile) => <Tile key={tile.id} tile={tile} />)}
      </ul>
    </section>
  );
}

function Tile({ tile }: { tile: PinnedTile }) {
  return (
    <li className="relative grid min-h-32 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_1fr] gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary/30">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted"
        >
          {tile.icon}
        </span>
        <div className="min-w-0 flex-1">
          {/* The whole tile opens it; buttons inside sit above this link. */}
          <IntentPrefetchLink
            href={tile.href}
            // The link covers the whole tile, so its tooltip is the one a
            // hover finds: the name and status in full, however they truncate.
            title={
              typeof tile.status === "string" && tile.status
                ? `${tile.name}\n${tile.status}`
                : tile.name
            }
            className="block truncate text-[15px] font-semibold after:absolute after:inset-0 after:rounded-xl"
          >
            {tile.name}
          </IntentPrefetchLink>
          <p className="h-[18px] truncate text-xs text-muted-foreground">
            {tile.status}
          </p>
        </div>
        <div className="relative z-10 flex shrink-0 items-center gap-0.5">
          <PinControl tile={tile} />
          {tile.menu}
        </div>
      </div>
      {/* Chips get a row of their own, held open when there are none, and
          the action its own below it: sharing one row put the chips beside
          the action on one tile and above it on the next. */}
      <div className="flex min-h-6 min-w-0 flex-wrap content-start gap-1">
        {tile.kind}
        {tile.pinnedBecause?.map((reason) => (
          <PinReasonChip key={reason} reason={reason} />
        ))}
      </div>
      {tile.action && (
        <div className="relative z-10 ml-auto shrink-0 self-end [&>*]:min-w-24">
          {tile.action}
        </div>
      )}
    </li>
  );
}

/**
 * Why something is pinned for you without your having pinned it, with what
 * that reason means on hover or focus.
 */
function PinReasonChip({ reason }: { reason: string }) {
  const chip = (
    <span
      // Focusable when it explains itself, so keyboard users reach the
      // explanation too; above the tile's whole-card link either way.
      tabIndex={PIN_REASON_EXPLANATION[reason] ? 0 : undefined}
      className="relative z-10 inline-flex cursor-default items-center whitespace-nowrap rounded-full border border-amber-300/70 bg-amber-50 px-2 py-px text-xs text-amber-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200"
    >
      {reason}
    </span>
  );
  const explanation = PIN_REASON_EXPLANATION[reason];
  if (!explanation) return chip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent className="max-w-64">{explanation}</TooltipContent>
    </Tooltip>
  );
}

function PinControl({ tile }: { tile: PinnedTile }) {
  if (!tile.onUnpin) {
    const why = automaticPinText(tile.pinnedBecause ?? []);
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label={why}
            className="relative z-10 flex size-7 shrink-0 items-center justify-center text-muted-foreground"
          >
            <Pin className="size-3.5 fill-current" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{why}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="relative z-10 shrink-0 text-primary"
      aria-label={`Unpin ${tile.name}`}
      onClick={tile.onUnpin}
    >
      <Pin className="size-3.5 fill-current" />
    </Button>
  );
}

/**
 * "Pinned automatically because …" for a tile's why-chips, so the marker says
 * what put it there rather than only that something did.
 */
function automaticPinText(reasons: string[]): string {
  const clauses = reasons.map((reason) => PIN_REASON_CLAUSE[reason] ?? reason);
  if (clauses.length === 0) return "Pinned automatically";
  const joined =
    clauses.length === 1
      ? clauses[0]
      : `${clauses.slice(0, -1).join(", ")} and ${clauses.at(-1)}`;
  return `Pinned automatically because ${joined}`;
}

const PIN_REASON_CLAUSE: Record<string, string> = {
  "Your default": "it's your default agent",
  "Personal agent": "it's your personal chat agent",
  "Org default": "it's your organization's default agent",
  Personal: "it's your personal MCP gateway",
  "Connect default": "the Connect page pre-selects it",
};

const PIN_REASON_EXPLANATION: Record<string, string> = {
  "Your default":
    "Your new chats start on this agent. You chose it with Set as default.",
  "Personal agent":
    "Your personal chat agent: the assistant created for you when you first signed in (your oldest personal agent). Only you can use it.",
  "Org default":
    "New chats start on this agent for everyone who hasn't chosen their own default. Admins set it in Agent settings.",
  Personal:
    "Your own MCP gateway, created for you. MCP servers you install are connected to it automatically.",
  "Connect default":
    "The gateway the Connect page pre-selects when you connect Claude Code, Cursor or another client.",
};
