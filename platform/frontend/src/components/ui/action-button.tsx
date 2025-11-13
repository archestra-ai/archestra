import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type ActionButtonProps = {
  children: ReactNode;
  tooltip: string;
  onClick: (e: React.MouseEvent) => void;
  testId?: string;
  className?: string;
  "data-testid"?: string;
  "aria-label"?: string;
};
export function ActionButton({
  children,
  tooltip,
  onClick,
  "data-testid": dataTestId,
  "aria-label": ariaLabel,
  className,
}: ActionButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.stopPropagation();
            onClick(e);
          }}
          data-testid={dataTestId}
          aria-label={ariaLabel || ""}
          className={`border h-8 w-8 ${className}`}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
