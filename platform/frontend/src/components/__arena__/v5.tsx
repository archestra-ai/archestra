"use client";

import { cn } from "@/lib/utils/tailwind";
import { BUTTON_GROUP, FOOTER_SHELL, type FooterVariantProps } from "./types";

/**
 * Variant 5 — Ghost center. The version floats at the bar's true center on
 * sm+ (absolutely positioned, so unequal button groups never pull it off
 * axis), in a faint mono that only firms up on hover. On phones it sits
 * centered under the stacked buttons.
 */
export function Variant({
  left,
  right,
  className,
  slotProps,
}: FooterVariantProps) {
  return (
    <div
      data-wizard-footer
      className={cn(FOOTER_SHELL, "relative flex flex-col")}
    >
      <div
        className={cn(
          "flex min-w-0 flex-col items-stretch gap-2 py-4 sm:flex-row sm:items-center sm:justify-between",
          className,
        )}
      >
        {left.length > 0 && (
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
            "flex flex-col gap-2 sm:ml-auto sm:flex-row sm:items-center",
            BUTTON_GROUP,
          )}
        >
          {right}
        </div>
      </div>
      <div
        {...slotProps}
        className={cn(
          "pb-3 text-center empty:hidden",
          // sm+: pinned to the bar's geometric center, clear of the buttons.
          "sm:absolute sm:top-1/2 sm:left-1/2 sm:max-w-[28%] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:pb-0",
          // Restyle the portaled line: faint mono, full muted on hover.
          "[&>div]:truncate [&>div]:font-mono [&>div]:text-[11px] [&>div]:tracking-tight [&>div]:text-muted-foreground/50 [&>div]:tabular-nums [&>div]:transition-colors [&>div]:duration-200 [&>div:hover]:text-muted-foreground",
        )}
      />
    </div>
  );
}
