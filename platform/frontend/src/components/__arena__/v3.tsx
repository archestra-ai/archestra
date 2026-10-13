"use client";

import { cn } from "@/lib/utils/tailwind";
import { BUTTON_GROUP, FOOTER_SHELL, type FooterVariantProps } from "./types";

/**
 * Border legend: the version sits centred on the bar's top hairline, the way
 * a <fieldset> legend cuts its border. It is taken out of flow on sm+, so the
 * bar is exactly as tall as its buttons; on a phone it drops under them.
 */
export function Variant({
  left,
  right,
  className,
  slotProps,
}: FooterVariantProps) {
  const hasLeft = left.length > 0;
  return (
    <div
      data-wizard-footer
      className={cn(FOOTER_SHELL, "relative flex flex-col")}
    >
      {/* No side padding: the buttons line up with the fields above. */}
      <div
        className={cn(
          "flex min-w-0 flex-col items-stretch gap-2 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between",
          className,
        )}
      >
        {hasLeft && (
          <div className={cn("flex flex-col gap-2 sm:flex-row", BUTTON_GROUP)}>
            {left}
          </div>
        )}
        <div
          className={cn(
            "flex flex-col gap-2 sm:flex-row",
            !hasLeft && "sm:ml-auto",
            BUTTON_GROUP,
          )}
        >
          {right}
        </div>
      </div>
      {/* bg-background masks the border behind the text; leading-none keeps
          the line box tight so the hairline meets the glyphs' midline. */}
      <div
        {...slotProps}
        className={cn(
          "pb-3 text-center empty:hidden",
          "sm:absolute sm:top-0 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:bg-background sm:px-2 sm:pb-0",
          "[&>div]:text-[11px] [&>div]:tabular-nums [&>div]:tracking-wide [&>div]:whitespace-nowrap sm:[&>div]:leading-none",
        )}
      />
    </div>
  );
}
