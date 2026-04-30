"use client";

import type { ComponentProps } from "react";
import { createContext, useState } from "react";
import { Collapsible } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const ToolContext = createContext<{ hasOpened: boolean }>({
  hasOpened: false,
});

export const Tool = ({
  className,
  onOpenChange,
  open,
  children,
  ...props
}: ToolProps) => {
  const [hasOpened, setHasOpened] = useState<boolean>(
    open ?? Boolean((props as Record<string, unknown>).defaultOpen) ?? true,
  );

  const handleOpenChange = (open: boolean) => {
    if (open) setHasOpened(true);
    onOpenChange?.(open);
  };

  return (
    <ToolContext.Provider value={{ hasOpened: hasOpened || !!open }}>
      <Collapsible
        defaultOpen={false}
        open={open}
        className={cn("not-prose mb-4 w-full rounded-md border", className)}
        onOpenChange={handleOpenChange}
        {...props}
      >
        {children}
      </Collapsible>
    </ToolContext.Provider>
  );
};
