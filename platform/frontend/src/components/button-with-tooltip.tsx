import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type ButtonWithTooltipProps = ComponentProps<typeof Button> & {
  disabledText?: string;
};

export function ButtonWithTooltip({
  disabledText,
  ...props
}: ButtonWithTooltipProps) {
  if (props.disabled) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button {...props} />
            </span>
          </TooltipTrigger>
          <TooltipContent>{disabledText}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return <Button {...props} />;
}
