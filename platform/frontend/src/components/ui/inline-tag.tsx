import type * as React from "react";
import { cn } from "@/lib/utils";

interface InlineTagProps {
  children: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}

function InlineTag({ children, icon, className }: InlineTagProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap [&>svg]:h-3 [&>svg]:w-3",
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

export { InlineTag };
