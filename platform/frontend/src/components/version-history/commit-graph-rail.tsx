"use client";

import { format } from "date-fns";
import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { groupVersionsByDay } from "./group-versions-by-day";
import { LoadFailure } from "./load-failure";
import { HeadRef, ShortHash, VersionRef } from "./refs";

/** What a rail row needs; the agent, skill and app summaries all satisfy it. */
export interface RailVersion {
  id: string;
  version: number;
  createdAt: string;
  /** Absent for histories that do not hash their versions (apps). */
  contentHash?: string | null;
}

/**
 * A version history drawn as `git log --graph --oneline`: one node per
 * version on a hairline, newest first and grouped by day. HEAD is the filled
 * node, the selection is ringed, and a dashed tail leads to the older page
 * when there is one.
 *
 * The selected row follows the selection however it moves — a click, a `j`/`k`
 * keystroke, a restore landing a new head — so it scrolls into view, and keeps
 * keyboard focus with it when focus was already on the rail.
 */
export function CommitGraphRail({
  versions,
  headVersion,
  activeVersion,
  isActivePending = false,
  isLoading,
  isError,
  errorMessage,
  onRetry,
  emptyMessage,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onSelect,
}: {
  versions: RailVersion[];
  headVersion: number | null;
  activeVersion: number | null;
  /** The selected version is still loading; its node pulses until it lands. */
  isActivePending?: boolean;
  isLoading: boolean;
  isError: boolean;
  errorMessage: string;
  onRetry: () => void;
  /** What an empty, settled history says. */
  emptyMessage: string;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onSelect: (version: number) => void;
}) {
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (activeVersion === null || !list) return;
    const row = list.querySelector<HTMLElement>(
      `[data-rail-version="${activeVersion}"] > button`,
    );
    if (!row) return;
    // jsdom has no layout, so it has no scrollIntoView either.
    row.scrollIntoView?.({ block: "nearest" });
    if (list.contains(document.activeElement) && document.activeElement !== row)
      row.focus();
  }, [activeVersion]);

  return (
    <nav
      aria-label="Versions"
      className="min-h-0 overflow-y-auto border-b bg-muted/25 px-2.5 py-3.5 md:border-r md:border-b-0"
    >
      {isLoading && versions.length === 0 ? (
        <RailSkeleton />
      ) : isError && versions.length === 0 ? (
        <LoadFailure message={errorMessage} onRetry={onRetry} />
      ) : versions.length === 0 ? (
        <p className="px-2 font-mono text-xs text-muted-foreground">
          {emptyMessage}
        </p>
      ) : (
        <ol ref={listRef} className="flex flex-col font-mono">
          {railItems(versions).map((item, index, items) => {
            if (item.type === "day") {
              return (
                <li key={item.key} className="flex">
                  <GraphColumn>
                    {index > 0 ? (
                      <GraphLine style={{ top: 0, bottom: 0 }} />
                    ) : null}
                  </GraphColumn>
                  <span
                    className={cn(
                      "pb-1 pl-2 text-[10.5px] text-muted-foreground",
                      index === 0 ? "pt-0" : "pt-3",
                    )}
                  >
                    {item.label}
                  </span>
                </li>
              );
            }
            const { version } = item;
            const isHead = version.version === headVersion;
            const isActive = version.version === activeVersion;
            const isFirst = index === 1;
            const isLast = index === items.length - 1;
            return (
              <li key={version.id} data-rail-version={version.version}>
                <UnstyledButton
                  aria-current={isActive ? "true" : undefined}
                  aria-label={`Version ${version.version}${isHead ? " (current)" : ""}, ${formatRelativeTimeFromNow(version.createdAt)}`}
                  onClick={() => onSelect(version.version)}
                  className="group flex w-full cursor-pointer text-left outline-none"
                >
                  <GraphColumn>
                    {isFirst ? null : (
                      <GraphLine style={{ top: 0, height: NODE_Y }} />
                    )}
                    {isLast && !hasMore ? null : (
                      <GraphLine
                        dashed={isLast}
                        style={{ top: NODE_Y, bottom: 0 }}
                      />
                    )}
                    <GraphNode
                      head={isHead}
                      active={isActive}
                      pulsing={isActive && isActivePending}
                    />
                  </GraphColumn>
                  <span
                    className={cn(
                      "my-0.5 flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm px-2 py-1.5 transition-colors group-hover:bg-muted/70 group-focus-visible:ring-2 group-focus-visible:ring-ring/50",
                      isActive &&
                        "bg-primary/[0.07] shadow-[inset_2px_0_0_var(--primary)] group-hover:bg-primary/10",
                    )}
                  >
                    <span className="flex h-[18px] min-w-0 items-center gap-1.5 text-xs">
                      {version.contentHash ? (
                        <ShortHash hash={version.contentHash} />
                      ) : null}
                      {isHead ? <HeadRef /> : null}
                      <VersionRef version={version.version} strong={isActive} />
                    </span>
                    <span className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="truncate">
                        <span>
                          {formatRelativeTimeFromNow(version.createdAt)}
                        </span>
                        {version.version === 1 ? (
                          <span className="text-muted-foreground/70">
                            {" "}
                            (root)
                          </span>
                        ) : null}
                      </span>
                      <span className="ml-auto shrink-0 text-[10.5px] tabular-nums">
                        {format(new Date(version.createdAt), "HH:mm")}
                      </span>
                    </span>
                  </span>
                </UnstyledButton>
              </li>
            );
          })}
          {hasMore ? (
            <li className="flex">
              <GraphColumn>
                <GraphLine dashed style={{ top: 0, height: 14 }} />
                <svg
                  aria-hidden="true"
                  viewBox="0 0 12 12"
                  className="absolute top-[14px] left-1/2 size-3 -translate-x-1/2"
                >
                  <circle
                    cx="6"
                    cy="6"
                    r="4"
                    strokeWidth="1.25"
                    strokeDasharray="2 1.6"
                    className="fill-none stroke-muted-foreground/60"
                  />
                </svg>
              </GraphColumn>
              <div className="pt-1.5 pl-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="font-mono text-muted-foreground"
                  disabled={isLoadingMore}
                  onClick={onLoadMore}
                >
                  {isLoadingMore
                    ? "Loading older versions..."
                    : "Load older versions"}
                </Button>
              </div>
            </li>
          ) : null}
        </ol>
      )}
    </nav>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

type RailItem =
  | { type: "day"; key: string; label: string }
  | { type: "version"; version: RailVersion };

/** Vertical centre of a row's first line, where its node sits. */
const NODE_Y = 17;

/** Day headings interleaved with their versions, in rail order. */
function railItems(versions: RailVersion[]): RailItem[] {
  return groupVersionsByDay(versions).flatMap((group): RailItem[] => [
    // A day can recur when versions arrive out of order, so the heading is
    // keyed by the first version under it.
    { type: "day", key: `day-${group.versions[0]?.id}`, label: group.label },
    ...group.versions.map((version) => ({ type: "version" as const, version })),
  ]);
}

function GraphColumn({ children }: { children?: ReactNode }) {
  return <span className="relative w-6 shrink-0">{children}</span>;
}

function GraphLine({
  style,
  dashed = false,
}: {
  style: CSSProperties;
  dashed?: boolean;
}) {
  return (
    <span
      aria-hidden
      style={style}
      className={cn(
        "absolute left-1/2 -translate-x-1/2",
        dashed
          ? "border-l border-dashed border-muted-foreground/35"
          : "w-px bg-muted-foreground/30",
      )}
    />
  );
}

/** A filled node with a halo for HEAD, a hollow one otherwise, ringed when selected. */
function GraphNode({
  head,
  active,
  pulsing,
}: {
  head: boolean;
  active: boolean;
  pulsing: boolean;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      style={{ top: NODE_Y }}
      className={cn(
        "absolute left-1/2 z-10 size-5 -translate-x-1/2 -translate-y-1/2 overflow-visible",
        pulsing && "animate-pulse motion-reduce:animate-none",
      )}
    >
      {head ? (
        <>
          <circle cx="10" cy="10" r="7" className="fill-primary/15" />
          <circle cx="10" cy="10" r="4" className="fill-primary" />
        </>
      ) : (
        <circle
          cx="10"
          cy="10"
          r="3.5"
          strokeWidth="1.5"
          className={cn(
            "fill-background transition-colors",
            active
              ? "stroke-primary"
              : "stroke-muted-foreground/55 group-hover:stroke-foreground/70",
          )}
        />
      )}
      {active ? (
        <circle
          cx="10"
          cy="10"
          r={head ? 9 : 7}
          strokeWidth="1.25"
          className="fill-none stroke-primary"
        />
      ) : null}
    </svg>
  );
}

function RailSkeleton() {
  return (
    <div className="flex flex-col gap-4 pl-2">
      <span className="sr-only">Loading versions...</span>
      <Skeleton aria-hidden className="ml-7 h-3 w-20" />
      {SKELETON_ROWS.map((row) => (
        <div key={row} aria-hidden className="flex items-center gap-3.5">
          <Skeleton className="size-2.5 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-36" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

const SKELETON_ROWS = ["a", "b", "c", "d", "e"];
