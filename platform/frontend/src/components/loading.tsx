import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "./ui/skeleton";

export function LoadingSkeletons({
  rows = 4,
  skeletonProps,
}: {
  rows?: number;
  skeletonProps?: ComponentProps<typeof Skeleton>;
}) {
  return (
    <div className="space-y-4">
      {Array.from({ length: rows }).map((_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: in this case, it's ok, no reordering of items
        <Skeleton key={index} className="h-6 w-full" {...skeletonProps} />
      ))}
    </div>
  );
}

export function LoadingSpinner({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-spin rounded-full h-6 w-6 border-b-2 border-primary mx-auto",
        className,
      )}
    />
  );
}

export function LoadingWrapper({
  isPending,
  error,
  loadingFallback = <LoadingSpinner className="top-1/2 left-1/2 absolute" />,
  errorFallback = null,
  children,
}: {
  isPending: boolean;
  error?: Error | null;
  /** Skeleton/loading UI to show while loading */
  loadingFallback?: ReactNode;
  /** Error UI to show on error. Falls back to null if not provided. */
  errorFallback?: ReactNode;
  children: ReactNode;
}) {
  if (isPending) return <>{loadingFallback}</>;
  if (error) return <>{errorFallback}</>;
  return <>{children}</>;
}
