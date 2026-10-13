"use client";

import { cn } from "@/lib/utils/tailwind";
import { BUTTON_GROUP, FOOTER_SHELL, type FooterVariantProps } from "./types";

/**
 * Variant 6 — trailing meta. The version reads as metadata attached to the
 * action area: right-aligned, just before the primary group, split from it by
 * a hairline. Secondary actions stay on the far left. On phones the bar
 * stacks and the version centres under the buttons.
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
          "flex flex-col items-stretch gap-2 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3",
          className,
        )}
      >
        {left.length > 0 && (
          <div className={cn("flex flex-col gap-2 sm:flex-row", BUTTON_GROUP)}>
            {left}
          </div>
        )}
        {/* `peer` lets the hairline and the primary group react when the
            version has not arrived yet, so no orphan divider shows. */}
        <div
          {...slotProps}
          className="peer order-last min-w-0 pt-1 text-center empty:hidden sm:order-none sm:ml-auto sm:max-w-[40ch] sm:pt-0 sm:text-right [&>div]:truncate [&>div]:tabular-nums"
        />
        <span
          aria-hidden="true"
          className="hidden h-4 w-px shrink-0 bg-border sm:block sm:peer-empty:hidden"
        />
        <div
          className={cn(
            "flex flex-col gap-2 sm:flex-row sm:peer-empty:ml-auto",
            BUTTON_GROUP,
          )}
        >
          {right}
        </div>
      </div>
    </div>
  );
}
