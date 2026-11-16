"use client";

import { ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils/tailwind";

export function AdvancedSection({
  children,
  className,
  defaultOpen,
  keepMounted,
  scrollIntoViewOnOpen = false,
}: {
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
  keepMounted?: boolean;
  /** Reveal optional fields within a scrollable form after expansion. */
  scrollIntoViewOnOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const contentRef = useRef<HTMLDivElement>(null);
  const openedByUser = useRef(false);

  useEffect(() => {
    if (!open || !scrollIntoViewOnOpen || !openedByUser.current) return;
    openedByUser.current = false;
    // Wait for the newly mounted Radix content to finish its layout effects.
    const frame = requestAnimationFrame(() => {
      contentRef.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
        block: "nearest",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, scrollIntoViewOnOpen]);

  return (
    <Collapsible
      open={open}
      onOpenChange={(nextOpen) => {
        openedByUser.current = nextOpen;
        setOpen(nextOpen);
      }}
      className={cn("border-t pt-3", className)}
    >
      <CollapsibleTrigger
        type="button"
        className="group flex w-full cursor-pointer items-center justify-between"
      >
        <span className="text-sm font-medium">Advanced</span>
        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent
        ref={contentRef}
        forceMount={keepMounted ? true : undefined}
        hidden={!open}
        className="space-y-4 pt-4"
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
