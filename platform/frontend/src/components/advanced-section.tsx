"use client";

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils/tailwind";

export function AdvancedSection({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Collapsible className={cn("border-t pt-3", className)}>
      <CollapsibleTrigger
        type="button"
        className="group flex w-full cursor-pointer items-center justify-between"
      >
        <span className="text-sm font-medium">Advanced</span>
        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 pt-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
