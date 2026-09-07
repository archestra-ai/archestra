"use client";

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
  | "fill"
  | "content"
  | "compact"
  | "inline"
  | "quiet";

const INDICATOR_SIZE_BY_VARIANT: Record<LoadingStateVariant, string> = {
  viewport: "size-8",
  page: "size-8",
  fill: "size-8",
  content: "size-8",
  compact: "size-6",
  inline: "size-4",
  quiet: "size-0",
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
  showLabel = variant !== "inline" && variant !== "quiet",
}: {
  className?: string;
  /**
   * Accessible name announced to assistive tech (WCAG 4.1.3 Status Messages).
   * The loading state is a polite live region, so screen-reader users hear it
   * when it appears. Pass a context-specific label (e.g. "Loading tools") where the
   * generic default is unhelpful.
   */
  label?: string;
  /**
   * Controls the centered loading area's height and indicator size.
   *
   * `fill` centres inside whatever box its parent gives it, rather than
   * deriving a height from the viewport. Use it wherever the surrounding
   * layout already owns the height — notably surfaces with no app header or
   * page header, where `page`'s `100dvh - 12rem` describes chrome that is not
   * there and lands the indicator above centre.
   *
   * `quiet` holds the area open and announces itself to assistive tech while
   * drawing nothing. Use it where a visible indicator would be a flash rather
   * than information — a boot step short enough that the eye reads the spinner
   * as a glitch, or one where the app cannot yet tell which layout it is about
   * to show.
   */
  variant?: LoadingStateVariant;
  /** Compact controls can hide the visible label while retaining its accessible name. */
  showLabel?: boolean;
}) {
  const delayEntrance = useDelayedEntrance();

  return (
    <output
      aria-label={label}
      className={cn(
        "flex flex-col items-center justify-center text-center",
        // A spinner that comes and goes inside a couple of hundred
        // milliseconds reports nothing — the eye reads it as the page
        // glitching, and a screen that flashes one on every gate reads as
        // broken even when every gate is fast. Holding the entrance back means
        // anything that resolves quickly resolves invisibly, and only a wait
        // long enough to notice ever draws. `backwards` fill-mode keeps it
        // transparent during the delay rather than showing then fading.
        delayEntrance &&
          "animate-in fade-in-0 duration-200 [animation-delay:200ms] [animation-fill-mode:backwards] motion-reduce:animate-none",
        variant === "viewport" && "min-h-app-viewport",
        variant === "page" &&
          "min-h-[calc(var(--visual-viewport-height,100dvh)-12rem)]",
        variant === "fill" && "h-full min-h-0 flex-1",
        variant === "content" && "min-h-48 py-10",
        variant === "compact" && "min-h-24 py-4",
        variant === "inline" && "inline-flex min-h-0 p-0 align-middle",
        variant === "quiet" && "min-h-app-viewport",
        className,
      )}
    >
      {variant !== "quiet" && (
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
      )}
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

/**
 * Whether this indicator should hold its entrance back.
 *
 * Two rules that pull in opposite directions, and neither is a property of the
 * call site — which is why this is decided per mount rather than per prop:
 *
 * - A wait too short to read should draw nothing. Delaying the entrance means
 *   a gate that resolves quickly resolves invisibly instead of strobing.
 * - An indicator replacing one that was just on screen has no wait to
 *   introduce; delaying it blanks the area across the handover, which reads as
 *   the page dropping its content rather than as one continuous wait.
 *
 * The same component is both, depending on what happened immediately before
 * it: the auth route's Suspense fallback takes over from the session gate on a
 * first load, and opens a fresh wait on a client-side navigation. So ask the
 * screen instead of the caller — if an indicator is up, or was up moments ago,
 * this is a handover.
 *
 * SSR renders the delayed form, and so does the client at hydration (nothing
 * can have unmounted yet), so the two agree.
 */
function useDelayedEntrance() {
  const [delayEntrance] = useState(() => !isHandover());

  useEffect(() => {
    visibleIndicators += 1;
    return () => {
      visibleIndicators -= 1;
      lastIndicatorHiddenAt = Date.now();
    };
  }, []);

  return delayEntrance;
}

function isHandover() {
  if (typeof window === "undefined") return false;
  return (
    visibleIndicators > 0 ||
    Date.now() - lastIndicatorHiddenAt < HANDOVER_WINDOW_MS
  );
}

/**
 * How recently another indicator must have left for this one to count as
 * taking over from it. A swap unmounts the outgoing indicator and mounts the
 * incoming one in the same commit, so in practice this compares against a few
 * milliseconds ago; the window only needs to be wider than a frame.
 */
const HANDOVER_WINDOW_MS = 150;

let visibleIndicators = 0;
let lastIndicatorHiddenAt = 0;
