import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export type ToolErrorDetailsProps = ComponentProps<"div"> & {
  errorText: string;
};

export const ToolErrorDetails = ({
  className,
  errorText,
  ...props
}: ToolErrorDetailsProps) => (
  <div className={cn("space-y-2 overflow-hidden p-4", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Details
    </h4>
    <div className="rounded-md bg-destructive/10 p-3 text-destructive text-xs whitespace-pre-wrap break-words select-text">
      {errorText}
    </div>
  </div>
);
