"use client";

import type { ComponentProps } from "react";
import { useContext } from "react";
import { CollapsibleContent } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ToolContext } from "./tool";

export type ToolContentProps = Omit<
  ComponentProps<typeof CollapsibleContent>,
  "forceMount"
> & {
  /** Keep children mounted even when closed (useful for MCP apps that need to preserve iframe state) */
  forceMount?: boolean;
};

export const ToolContent = ({
  className,
  children,
  forceMount = false,
  ...props
}: ToolContentProps) => {
  const { hasOpened } = useContext(ToolContext);

  const resolvedClassName = cn(
    "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
    forceMount &&
      "overflow-hidden data-[state=closed]:max-h-0 data-[state=open]:max-h-[5000px]",
    className,
  );

  if (forceMount) {
    return (
      <CollapsibleContent className={resolvedClassName} forceMount {...props}>
        {children}
      </CollapsibleContent>
    );
  }

  return (
    <CollapsibleContent className={resolvedClassName} {...props}>
      {hasOpened ? children : null}
    </CollapsibleContent>
  );
};
