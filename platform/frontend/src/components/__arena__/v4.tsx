"use client";

import { cn } from "@/lib/utils/tailwind";
import { BUTTON_GROUP, FOOTER_SHELL, type FooterVariantProps } from "./types";

/**
 * Variant 4 — sub-line. The buttons row stays exactly as today; the version
 * sits under it as a slim, centred caption, echoing the old bottom-centre
 * placement of the page footer while staying inside the sticky bar.
 */
export function Variant({
  left,
  right,
  className,
  slotProps,
}: FooterVariantProps) {
  const hasLeft = left.length > 0;
  return (
    <div data-wizard-footer className={cn(FOOTER_SHELL, "flex flex-col")}>
      {/* No side padding: the buttons line up with the fields above. */}
      <div
        className={cn(
          "flex min-w-0 flex-col items-stretch gap-2 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:py-3",
          className,
        )}
      >
        {hasLeft && (
          <div
            className={cn(
              "flex flex-col gap-2 sm:flex-row sm:items-center",
              BUTTON_GROUP,
            )}
          >
            {left}
          </div>
        )}
        <div
          className={cn(
            "flex flex-col gap-2 sm:flex-row sm:items-center",
            !hasLeft && "sm:ml-auto",
            BUTTON_GROUP,
          )}
        >
          {right}
        </div>
      </div>
      {/* Caption line: tight to the buttons, quiet enough to read as
          metadata rather than a control. */}
      <div
        {...slotProps}
        className="-mt-1 select-text pb-3 text-center empty:hidden sm:pb-2 [&>div]:text-[11px] [&>div]:leading-none [&>div]:tabular-nums [&>div]:text-muted-foreground/80 [&_a]:text-muted-foreground"
      />
    </div>
  );
}
