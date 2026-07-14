import type * as React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The muted pill used for status chips in the composer toolbar (model source,
 * no-tools). One component so every chip shares the same colors, padding, and
 * glyph centering: leading-none collapses the text's default 16px line box to
 * the glyph size so it truly centers against 12px icons, and py-1.5 restores
 * the height that line box used to provide.
 */
export function ComposerBadge({
  className,
  ...props
}: React.ComponentProps<typeof Badge>) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "gap-1 bg-slate-200/70 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300 px-2.5 py-1.5 text-xs font-medium leading-none",
        className,
      )}
      {...props}
    />
  );
}
