"use client";

import { usePathname } from "next/navigation";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "./ui/skeleton";

type LoadingStateVariant =
  | "viewport"
  | "page"
  | "content"
  | "compact"
  | "inline";

const LOADING_MASCOTS = [
  {
    light: "/loading/openappa-headphones-light.gif",
    dark: "/loading/openappa-headphones-dark.gif",
  },
  {
    light: "/loading/openappa-step-light.gif",
    dark: "/loading/openappa-step-dark.gif",
  },
  {
    light: "/loading/openappa-bop-light.gif",
    dark: "/loading/openappa-bop-dark.gif",
  },
] as const;

const MASCOT_SIZE_BY_VARIANT: Record<LoadingStateVariant, number> = {
  viewport: 75,
  page: 75,
  content: 75,
  compact: 41,
  inline: 17,
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
  const pathname = usePathname();
  const startingMascot =
    hashLoadingKey(pathname ?? "/") % LOADING_MASCOTS.length;
  const [mascotOffset, setMascotOffset] = useState(0);
  const mascot =
    LOADING_MASCOTS[(startingMascot + mascotOffset) % LOADING_MASCOTS.length];
  const mascotSize = MASCOT_SIZE_BY_VARIANT[variant];

  useEffect(() => {
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const interval = window.setInterval(() => {
      setMascotOffset((offset) => offset + 1);
    }, 6480);

    return () => window.clearInterval(interval);
  }, []);

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
        className="relative block"
        style={{
          height: mascotSize,
          width: mascotSize,
        }}
      >
        <img
          alt=""
          className="absolute inset-0 h-full w-full object-contain dark:hidden"
          src={mascot.light}
        />
        <img
          alt=""
          className="absolute inset-0 hidden h-full w-full object-contain dark:block"
          src={mascot.dark}
        />
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

function hashLoadingKey(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
