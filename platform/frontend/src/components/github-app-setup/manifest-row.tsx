"use client";

import { AlertTriangle, Check, LoaderCircle } from "lucide-react";
import type * as React from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/tailwind";

/**
 * One step of registering a GitHub App on GitHub (create it, install it): its
 * number, what to do, and then either the action, the wait on GitHub with a
 * way to check again, the error, or the result.
 */
export function ManifestRow({
  index,
  title,
  hint,
  waiting,
  locked = false,
  onCheckAgain,
  result,
  action,
  inlineAction = false,
  error,
}: {
  index: number;
  title: string;
  hint: string;
  /**
   * Takes the hint's place while this step's last attempt failed, in the
   * hint's own lines (clamped, whole in its tooltip), so nothing moves. A
   * step with an inline action also offers to check GitHub again there.
   */
  error?: string;
  waiting: boolean;
  locked?: boolean;
  onCheckAgain: () => void;
  result: React.ReactNode;
  action: React.ReactNode;
  /** Short actions sit beside the text; wide ones (a form) go underneath. */
  inlineAction?: boolean;
}) {
  const done = !!result;
  // While GitHub is waiting the action keeps its place, hidden, so the text
  // beside it keeps its width.
  const showAction = !(done || locked);
  const hintRef = useRef<HTMLParagraphElement>(null);
  const hintLines = useLineCount(hintRef);
  return (
    <li
      className={cn(
        "flex items-start gap-3 border-b p-4 last:border-b-0 transition-opacity",
        locked && "opacity-60",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums transition-colors",
          done &&
            "border-emerald-600/30 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-950/50 dark:text-emerald-400",
        )}
      >
        {done ? <Check className="size-3.5" /> : <span>{index}</span>}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {done ? (
          <div className="flex flex-wrap items-center gap-2 animate-in fade-in duration-300">
            {result}
          </div>
        ) : (
          // The hint holds its lines; waiting or an error is laid over them.
          <div className="relative">
            <p
              ref={hintRef}
              className={cn(
                "text-xs text-muted-foreground",
                (waiting || error) && "invisible",
              )}
              aria-hidden={waiting || !!error ? true : undefined}
            >
              {hint}
            </p>
            {waiting ? (
              <p
                className="absolute inset-0 flex items-start gap-2 overflow-hidden text-xs text-muted-foreground"
                aria-live="polite"
              >
                <LoaderCircle className="mt-px size-3.5 shrink-0 animate-spin" />
                <span className="truncate">
                  Finish in the GitHub tab that opened.
                </span>
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="h-auto shrink-0 px-0"
                  onClick={onCheckAgain}
                >
                  <span>Done? Check again</span>
                </Button>
              </p>
            ) : error ? (
              <div className="absolute inset-0 flex items-start gap-1.5 overflow-hidden text-xs text-destructive">
                <AlertTriangle
                  className="mt-px size-3.5 shrink-0"
                  aria-hidden
                />
                <p
                  role="alert"
                  title={error}
                  className="min-w-0 flex-1 overflow-hidden"
                  style={{
                    display: "-webkit-box",
                    WebkitBoxOrient: "vertical",
                    WebkitLineClamp: hintLines,
                  }}
                >
                  {error}
                </p>
                {inlineAction ? (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="h-auto shrink-0 px-0"
                    onClick={onCheckAgain}
                  >
                    <span>Check again</span>
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
        {showAction && !inlineAction ? (
          <div className={cn("pt-2", waiting && "invisible")} inert={waiting}>
            {action}
          </div>
        ) : null}
      </div>
      {showAction && inlineAction ? (
        <div
          className={cn(
            "flex shrink-0 items-center gap-2 self-center",
            waiting && "invisible",
          )}
          inert={waiting}
        >
          {action}
        </div>
      ) : null}
    </li>
  );
}

/** How many lines an element's text takes, kept current as it rewraps. */
function useLineCount(ref: React.RefObject<HTMLElement | null>) {
  const [lines, setLines] = useState(1);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const lineHeight = Number.parseFloat(
        getComputedStyle(element).lineHeight,
      );
      if (lineHeight > 0)
        setLines(Math.max(1, Math.round(element.offsetHeight / lineHeight)));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return lines;
}
