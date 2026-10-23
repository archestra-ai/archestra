"use client";

import { GitCommitVertical } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils/tailwind";

/**
 * The frame every version history dialog shares: a title row naming the
 * entity, an optional notice, the commit-graph rail beside the selected
 * version's pane, and the status line along the bottom. It is a custom layout
 * rather than a `StandardDialog` because the status line takes the footer's
 * place and the rail and pane run edge to edge.
 *
 * Keyboard shortcuts are handled on the dialog surface, so they work wherever
 * focus is inside it; the handler decides what to ignore.
 */
export function VersionHistoryShell({
  open,
  onOpenChange,
  subtitle,
  headerAction,
  notice,
  rail,
  pane,
  emptyState,
  statusLine,
  onKeyDown,
  size = "large",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The line under the title: what this is the history of. */
  subtitle: ReactNode;
  /** An action for the entity as a whole, beside the close button. */
  headerAction?: ReactNode;
  notice?: ReactNode;
  rail: ReactNode;
  pane: ReactNode;
  /** Shown in place of the rail and the pane, for a history not started yet. */
  emptyState?: ReactNode;
  statusLine: ReactNode;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  /** `compact` for a history with no content preview (apps). */
  size?: "large" | "compact";
  /** Dialogs layered over this one, such as the restore confirmation. */
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onKeyDown={onKeyDown}
        className={cn(
          "gap-0 pt-0",
          size === "large"
            ? "h-[90dvh] max-w-6xl"
            : "h-[min(40rem,85dvh)] max-w-3xl",
        )}
      >
        <div className="flex items-center gap-3.5 border-b py-3 pr-12 pl-5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/50">
            <GitCommitVertical className="size-4.5 text-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base leading-tight font-semibold">
              Version history
            </DialogTitle>
            <DialogDescription className="mt-0.5 flex min-w-0 items-center gap-2 text-xs">
              {subtitle}
            </DialogDescription>
          </div>
          {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
        </div>

        {notice ? <div className="border-b px-5 py-2">{notice}</div> : null}

        {emptyState ?? (
          <div
            className={cn(
              "grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,14rem)_minmax(0,1fr)] md:grid-rows-1",
              size === "large"
                ? "md:grid-cols-[18rem_minmax(0,1fr)]"
                : "md:grid-cols-[16rem_minmax(0,1fr)]",
            )}
          >
            {rail}
            <section
              aria-label="Selected version"
              className="relative flex min-h-0 min-w-0 flex-col"
            >
              {pane}
            </section>
          </div>
        )}

        {statusLine}
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** "Support bot · 12 versions": the entity and how much history is loaded. */
export function VersionHistorySubtitle({
  name,
  versionCount,
  hasMore,
  isLoading,
  fallback,
}: {
  name: string | undefined;
  versionCount: number;
  hasMore: boolean;
  /** The list is still on its way, so its length says nothing yet. */
  isLoading: boolean;
  /** Said instead while the entity is still unknown. */
  fallback: string;
}) {
  if (!name) return <span>{fallback}</span>;
  const countLabel =
    versionCount === 0
      ? "no versions yet"
      : `${versionCount}${hasMore ? "+" : ""} ${versionCount === 1 && !hasMore ? "version" : "versions"}`;
  return (
    <>
      <span className="truncate font-medium text-foreground">{name}</span>
      {isLoading ? null : (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {countLabel}
        </span>
      )}
    </>
  );
}
