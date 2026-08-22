import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Shared sticky action row for full-page create/edit wizards. */
export function WizardFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 border-t bg-background px-6 py-4",
        className,
      )}
    >
      {children}
    </div>
  );
}
