"use client";

import type { ComponentProps } from "react";
import { memo } from "react";
import { Response } from "@/components/ai-elements/response";
import { CollapsibleContent } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export type ReasoningContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string;
};

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => (
    <CollapsibleContent
      className={cn(
        "mt-4 text-sm",
        "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
        className,
      )}
      {...props}
    >
      <Response className="grid gap-2">{children}</Response>
    </CollapsibleContent>
  ),
);

ReasoningContent.displayName = "ReasoningContent";
