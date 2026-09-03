"use client";

import { TerminalSquare } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function RuntimeCapableIndicator({ className }: { className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex shrink-0 text-muted-foreground/60",
            className,
          )}
          role="img"
          aria-label="Dedicated runtime"
        >
          <TerminalSquare className="size-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">Uses a dedicated Agent Runtime</TooltipContent>
    </Tooltip>
  );
}
