"use client";

import type { ReasoningUIPart } from "ai";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { memo } from "react";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useReasoning } from "./reasoning-context";

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger>;

export const ReasoningTrigger = memo(
  ({ className, children, ...props }: ReasoningTriggerProps) => {
    const { state, isOpen, duration } = useReasoning();

    return (
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-4" />
            {getThinkingMessage(state, duration)}
            <ChevronDownIcon
              className={cn(
                "size-4 transition-transform",
                isOpen ? "rotate-180" : "rotate-0",
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  },
);

ReasoningTrigger.displayName = "ReasoningTrigger";

function getThinkingMessage(
  state: ReasoningUIPart["state"],
  duration?: number,
) {
  return (
    <p>
      {state === "done" ? "Thought" : "Thinking"}
      {(duration ?? 0) > 0 ? `for ${duration} seconds` : " a moment"}
    </p>
  );
}
