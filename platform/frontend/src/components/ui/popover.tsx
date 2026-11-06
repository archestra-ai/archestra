"use client";

import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as React from "react";

import { DialogContentContext } from "@/components/ui/dialog";
import { cn } from "@/lib/utils/tailwind";

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

type PopoverContentProps = React.ComponentProps<
  typeof PopoverPrimitive.Content
> & {
  portal?: boolean;
  portalContainer?: React.ComponentProps<
    typeof PopoverPrimitive.Portal
  >["container"];
};

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  portal = true,
  portalContainer,
  onWheel,
  onTouchMove,
  ...props
}: PopoverContentProps) {
  const withinDialog = React.useContext(DialogContentContext);
  const content = (
    <PopoverPrimitive.Content
      data-slot="popover-content"
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden",
        className,
      )}
      {...props}
      // The popover portals to <body>, outside the dialog's subtree. A modal
      // dialog locks scrolling by preventDefaulting, at the document, every
      // wheel and touch move that starts outside its subtree; stopping them
      // here keeps the popover's own lists scrollable.
      onWheel={(event) => {
        onWheel?.(event);
        if (withinDialog) event.stopPropagation();
      }}
      onTouchMove={(event) => {
        onTouchMove?.(event);
        if (withinDialog) event.stopPropagation();
      }}
    />
  );

  if (!portal) {
    return content;
  }

  return (
    <PopoverPrimitive.Portal container={portalContainer}>
      {content}
    </PopoverPrimitive.Portal>
  );
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
