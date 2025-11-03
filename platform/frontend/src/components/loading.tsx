import type { ComponentProps } from "react";
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
