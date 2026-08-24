"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "./ui/skeleton";

type LoadingStateVariant =
  | "viewport"
  | "page"
  | "content"
  | "compact"
  | "inline";

const INDICATOR_SIZE_BY_VARIANT: Record<LoadingStateVariant, string> = {
  viewport: "size-8",
  page: "size-8",
  content: "size-8",
  compact: "size-6",
  inline: "size-4",
};

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

export function LoadingState({
  className,
  label = "Loading…",
  variant = "content",
  showLabel = variant !== "inline",
}: {
  className?: string;
  /**
   * Accessible name announced to assistive tech (WCAG 4.1.3 Status Messages).
   * The loading state is a polite live region, so screen-reader users hear it
   * when it appears. Pass a context-specific label (e.g. "Loading tools") where the
   * generic default is unhelpful.
   */
  label?: string;
  /** Controls the centered loading area's height and mascot size. */
  variant?: LoadingStateVariant;
  /** Compact controls can hide the visible label while retaining its accessible name. */
  showLabel?: boolean;
}) {
  return (
    <output
      aria-label={label}
      className={cn(
        "flex flex-col items-center justify-center text-center",
        variant === "viewport" && "min-h-app-viewport",
        variant === "page" &&
          "min-h-[calc(var(--visual-viewport-height,100dvh)-12rem)] animate-in fade-in-0 duration-200 [animation-delay:150ms] [animation-fill-mode:backwards] motion-reduce:animate-none",
        variant === "content" && "min-h-48 py-10",
        variant === "compact" && "min-h-24 py-4",
        variant === "inline" && "inline-flex min-h-0 p-0 align-middle",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "relative block shrink-0",
          INDICATOR_SIZE_BY_VARIANT[variant],
        )}
      >
        <span className="absolute inset-0 rounded-full border-2 border-muted-foreground/20" />
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-muted-foreground motion-reduce:animate-none" />
      </span>
      {showLabel && (
        <span className="mt-2 text-sm text-muted-foreground">{label}</span>
      )}
    </output>
  );
}

export function LoadingWrapper({
  isPending,
  error,
  loadingFallback = <LoadingState />,
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
