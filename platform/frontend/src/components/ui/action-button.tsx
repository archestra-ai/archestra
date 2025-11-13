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
};
export function ActionButton({
  children,
  tooltip,
  onClick,
  testId,
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
          data-testid={testId}
          className={`border h-8 w-8 ${className}`}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
