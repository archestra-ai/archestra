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
        "sticky bottom-0 z-10 flex flex-col items-stretch gap-2 border-t bg-background px-6 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between [&>button]:w-full [&>div]:w-full [&>div>button]:w-full sm:[&>button]:w-auto sm:[&>div]:w-auto sm:[&>div>button]:w-auto",
        className,
      )}
    >
      {children}
    </div>
  );
}
