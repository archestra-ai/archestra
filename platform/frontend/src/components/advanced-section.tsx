"use client";

import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
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
}: {
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
  keepMounted?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
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
        forceMount={keepMounted ? true : undefined}
        hidden={!open}
        className="space-y-4 pt-4"
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
