import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Shared action row for full-page create/edit wizards. */
export function WizardFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  // No side padding: the buttons line up with the edges of the fields above.
  return (
    <div
      className={cn(
        "flex flex-col items-stretch gap-2 border-t bg-background py-4 sm:sticky sm:bottom-0 sm:z-10 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between [&>button]:w-full [&>div]:w-full [&>div]:flex-col [&>div>button]:w-full sm:[&>button]:w-auto sm:[&>div]:w-auto sm:[&>div]:flex-row sm:[&>div>button]:w-auto",
        className,
      )}
    >
      {children}
    </div>
  );
}
