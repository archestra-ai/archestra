"use client";

import * as HoverCardPrimitive from "@radix-ui/react-hover-card";
import type * as React from "react";

import { cn } from "@/lib/utils";

function HoverCard({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />;
}

function HoverCardTrigger({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return (
    <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
  );
}

function HoverCardContent({
  className,
  align = "center",
  sideOffset = 4,
  pointerEventsNone = false,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content> & {
  /**
   * Take the popover out of the hit-test path, so a click passes through to
   * whatever it is covering. Use it for purely informational content that
   * opens over interactive UI: a hover card floating above a row of buttons
   * otherwise absorbs the click and the button underneath looks dead.
   *
   * Radix positions the content inside a `[data-radix-popper-content-wrapper]`
   * div sized to the content, and that wrapper stays pointer-interactive — so
   * `pointer-events: none` on the content alone is not enough, the wrapper
   * still swallows the click. A child cannot style its ancestor, hence the
   * marker attribute plus the `:has()` rule in globals.css.
   */
  pointerEventsNone?: boolean;
}) {
  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal">
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        data-pointer-events-none={pointerEventsNone || undefined}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          pointerEventsNone && "pointer-events-none",
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-64 origin-(--radix-hover-card-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden",
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
