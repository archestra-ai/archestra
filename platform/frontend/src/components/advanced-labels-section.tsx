"use client";

import { ChevronDown } from "lucide-react";
import { forwardRef, type ReactNode } from "react";
import {
  type ProfileLabel,
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils/tailwind";

export const AdvancedLabelsSection = forwardRef<
  ProfileLabelsRef,
  {
    labels: ProfileLabel[];
    onLabelsChange: (labels: ProfileLabel[]) => void;
    className?: string;
    children?: ReactNode;
  }
>(function AdvancedLabelsSection(
  { labels, onLabelsChange, className, children },
  ref,
) {
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
        <ProfileLabels
          ref={ref}
          labels={labels}
          onLabelsChange={onLabelsChange}
        />
      </CollapsibleContent>
    </Collapsible>
  );
});
