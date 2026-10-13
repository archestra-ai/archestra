"use client";

import { cn } from "@/lib/utils/tailwind";
import { BUTTON_GROUP, FOOTER_SHELL, type FooterVariantProps } from "./types";

/**
 * Variant 2 - center chip. On sm+ the row is a three-column grid with equal
 * flexible side tracks, so the version tag sits on the bar's true center no
 * matter how wide either button group is. The version renders as a small
 * mono build tag (pill, hairline border, muted fill) rather than prose.
 * Phones: buttons stack full-width, the tag centers underneath.
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
          "flex flex-col items-stretch gap-2 py-4 sm:grid sm:grid-cols-[1fr_auto_1fr] sm:items-center sm:gap-4",
          className,
        )}
      >
        {/* Kept as an (empty) grid cell on sm+ so the chip stays centered
            and the primary group stays right when there is no left group. */}
        <div
          className={cn(
            "flex flex-col gap-2 max-sm:empty:hidden sm:col-start-1 sm:row-start-1 sm:flex-row sm:justify-self-start",
            BUTTON_GROUP,
          )}
        >
          {left}
        </div>
        <div
          {...slotProps}
          className={cn(
            "order-last flex justify-center pt-1 empty:hidden sm:order-none sm:col-start-2 sm:row-start-1 sm:pt-0",
            "[&>div]:whitespace-nowrap [&>div]:rounded-full [&>div]:border [&>div]:bg-muted/50 [&>div]:px-2 [&>div]:py-0.5",
            "[&>div]:font-mono [&>div]:text-[11px] [&>div]:leading-4 [&>div]:tabular-nums [&>div]:text-muted-foreground",
          )}
        />
        <div
          className={cn(
            "flex flex-col gap-2 sm:col-start-3 sm:row-start-1 sm:flex-row sm:justify-self-end",
            BUTTON_GROUP,
          )}
        >
          {right}
        </div>
      </div>
    </div>
  );
}
