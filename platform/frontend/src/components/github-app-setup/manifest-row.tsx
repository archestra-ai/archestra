"use client";

import { AlertTriangle, Check, LoaderCircle } from "lucide-react";
import type * as React from "react";
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
   * Replaces the hint while this step's last attempt failed. A step with an
   * inline action (install) also offers to check GitHub again beside it.
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
  const showAction = !(done || waiting || locked);
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
        ) : waiting ? (
          <p
            className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
            aria-live="polite"
          >
            <LoaderCircle className="size-3.5 animate-spin" />
            <span>Finish in the GitHub tab that opened.</span>
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto px-0"
              onClick={onCheckAgain}
            >
              <span>Done? Check again</span>
            </Button>
          </p>
        ) : error ? (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>{error}</span>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{hint}</p>
        )}
        {showAction && !inlineAction ? (
          <div className="pt-2">{action}</div>
        ) : null}
      </div>
      {showAction && inlineAction ? (
        <div className="flex shrink-0 items-center gap-2 self-center">
          {error ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCheckAgain}
            >
              <span>Check again</span>
            </Button>
          ) : null}
          {action}
        </div>
      ) : null}
    </li>
  );
}
