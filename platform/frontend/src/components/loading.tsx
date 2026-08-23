"use client";

import {
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "./ui/skeleton";

type LoadingStateVariant = "page" | "content" | "compact" | "inline";

const LOADING_MASCOTS = [
  {
    light: "/loading/openappa-headphones-light.png",
    dark: "/loading/openappa-headphones-dark.png",
  },
  {
    light: "/loading/openappa-step-light.png",
    dark: "/loading/openappa-step-dark.png",
  },
  {
    light: "/loading/openappa-bop-light.png",
    dark: "/loading/openappa-bop-dark.png",
  },
] as const;

const MASCOT_SIZE_BY_VARIANT: Record<LoadingStateVariant, number> = {
  page: 104,
  content: 88,
  compact: 48,
  inline: 20,
};

const MASCOT_MOTION: CSSProperties[] = [
  { transform: "translateY(0) rotate(-1deg)" },
  { transform: "translateY(-3px) rotate(1deg)" },
  { transform: "translateY(-1px) rotate(-1deg)" },
  { transform: "translateY(0) rotate(1deg)" },
];

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
   * it appears. Pass a context-specific label (e.g. "Loading tools") where the
   * generic default is unhelpful.
   */
  label?: string;
  /** Controls the centered loading area's height and mascot size. */
  variant?: LoadingStateVariant;
  /** Compact controls can hide the visible label while retaining its accessible name. */
  showLabel?: boolean;
}) {
  const loadingId = useId();
  const [motionFrame, setMotionFrame] = useState(0);
  const startingMascot = hashLoadingId(loadingId) % LOADING_MASCOTS.length;
  const mascot =
    LOADING_MASCOTS[
      (startingMascot + Math.floor(motionFrame / MASCOT_MOTION.length)) %
        LOADING_MASCOTS.length
    ];
  const mascotSize = MASCOT_SIZE_BY_VARIANT[variant];

  useEffect(() => {
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const interval = window.setInterval(() => {
      setMotionFrame((frame) => frame + 1);
    }, 650);

    return () => window.clearInterval(interval);
  }, []);

  return (
    <output
      aria-label={label}
      className={cn(
        "flex flex-col items-center justify-center text-center",
        variant === "page" && "min-h-[calc(100dvh-12rem)] py-16",
        variant === "content" && "min-h-48 py-10",
        variant === "compact" && "min-h-24 py-4",
        variant === "inline" && "inline-flex min-h-0 p-0 align-middle",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="relative block transition-transform duration-500 ease-in-out motion-reduce:transition-none"
        style={{
          height: mascotSize,
          width: mascotSize,
          ...MASCOT_MOTION[motionFrame % MASCOT_MOTION.length],
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

function hashLoadingId(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
