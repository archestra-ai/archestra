import type { ReactNode } from "react";
import { cn } from "@/lib/utils/tailwind";

/**
 * The title bar of one pane in a log detail split. Phones stack the panes in
 * the page's own scroll, so each bar sticks to the top while its pane is in
 * view, and is tall enough for 32px controls. From `md` the page header is
 * sticky itself and would cover it, and from `lg` the panes scroll on their
 * own, so there it is a plain strip above the pane.
 */
export function PaneHeader({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2 border-b bg-card px-4 md:static lg:h-9",
        className,
      )}
    >
      {children}
    </div>
  );
}
