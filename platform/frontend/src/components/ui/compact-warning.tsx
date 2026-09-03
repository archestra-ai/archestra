import type React from "react";
import { cn } from "@/lib/utils";

/**
 * Slim inline warning for space-constrained form and composer surfaces. Unlike
 * the full Alert, its title and explanation share a row and wrap only when the
 * available width requires it.
 */
export function CompactWarning({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-500/50 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/50 dark:text-amber-200 [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400",
        className,
      )}
      {...props}
    />
  );
}

export function CompactWarningText({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("text-amber-800 dark:text-amber-300", className)}
      {...props}
    />
  );
}
