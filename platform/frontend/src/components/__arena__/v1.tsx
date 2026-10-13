"use client";

import { cn } from "@/lib/utils/tailwind";
import { BUTTON_GROUP, FOOTER_SHELL, type FooterVariantProps } from "./types";

/**
 * Variant 1 — center column. On sm+ the bar is a three-track grid:
 * secondary actions | version | primary actions. The outer tracks share the
 * free space equally, so the version sits on the bar's true center line no
 * matter how wide either button group is. On phones the buttons stack
 * full-width and the version goes centered underneath.
 */
export function Variant({
  left,
  right,
  className,
  slotProps,
}: FooterVariantProps) {
  return (
    <div data-wizard-footer className={FOOTER_SHELL}>
      <div
        className={cn(
          "flex flex-col items-stretch gap-2 py-4",
          "sm:grid sm:grid-cols-[1fr_minmax(0,auto)_1fr] sm:items-center sm:gap-x-6",
          className,
        )}
      >
        {/* Empty on single-action wizards: hidden, and the explicit column
            starts below keep the version and primary group in place. */}
        <div
          className={cn(
            "flex flex-col gap-2 empty:hidden sm:col-start-1 sm:flex-row sm:items-center",
            BUTTON_GROUP,
          )}
        >
          {left}
        </div>
        <div
          className={cn(
            "flex flex-col gap-2 sm:col-start-3 sm:flex-row sm:items-center sm:justify-self-end",
            BUTTON_GROUP,
          )}
        >
          {right}
        </div>
        {/* Last in source so it lands under the stacked buttons on phones;
            on sm+ the grid pulls it into the middle track. */}
        <div
          {...slotProps}
          className="order-last min-w-0 pt-1 text-center empty:hidden sm:order-none sm:col-start-2 sm:row-start-1 sm:pt-0 [&>div]:truncate [&>div]:tabular-nums"
        />
      </div>
    </div>
  );
}
