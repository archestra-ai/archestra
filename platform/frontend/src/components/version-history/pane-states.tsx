import { Equal, GitCommitVertical } from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The pane while a version is on its way. The skeleton is decorative, so the
 * status is also spoken.
 */
export function PaneSkeleton() {
  return (
    <div className="flex flex-col">
      <span className="sr-only">Loading version...</span>
      <div
        aria-hidden
        className="flex items-start justify-between border-b px-6 pt-5 pb-4"
      >
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-36" />
          <Skeleton className="h-3.5 w-56" />
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3.5 w-72" />
        </div>
        <Skeleton className="h-8 w-32" />
      </div>
      <div
        aria-hidden
        className="flex items-center justify-between border-b px-6 py-2.5"
      >
        <Skeleton className="h-3.5 w-64" />
        <Skeleton className="h-7 w-48" />
      </div>
      <div aria-hidden className="flex flex-col gap-3 px-6 py-5">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-52 w-full" />
      </div>
    </div>
  );
}

/** A centred statement filling the pane: a version that is gone, and the like. */
export function PaneMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-full border border-dashed">
        <GitCommitVertical className="size-4 text-muted-foreground" />
      </div>
      <p className="max-w-xs text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

/** A comparison that found nothing: this version and its parent agree. */
export function NothingToDiff({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed px-6 py-12 text-center">
      <div className="flex size-9 items-center justify-center rounded-full bg-muted">
        <Equal className="size-4 text-muted-foreground" />
      </div>
      <div>
        <p className="font-mono text-[13px] font-medium">nothing to diff</p>
        <p className="mt-1 text-sm text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

/**
 * A history that has not started: drawn as a graph with no commits on it yet,
 * in place of both the rail and the pane.
 */
export function EmptyHistory({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
      <svg aria-hidden="true" viewBox="0 0 24 96" className="h-24 w-6">
        <line
          x1="12"
          y1="0"
          x2="12"
          y2="96"
          strokeWidth="1"
          strokeDasharray="3 3"
          className="stroke-muted-foreground/40"
        />
        <circle
          cx="12"
          cy="24"
          r="5"
          strokeWidth="1.5"
          strokeDasharray="2.5 2"
          className="fill-background stroke-muted-foreground/60"
        />
        <circle
          cx="12"
          cy="72"
          r="5"
          strokeWidth="1.5"
          strokeDasharray="2.5 2"
          className="fill-background stroke-muted-foreground/30"
        />
      </svg>
      <div>
        <p className="font-mono text-[13px] font-medium">no versions yet</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {children}
        </p>
      </div>
    </div>
  );
}
