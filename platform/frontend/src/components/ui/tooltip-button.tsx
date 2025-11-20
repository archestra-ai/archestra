/** Button with built-in tooltip. Is of icon variant by default. */
import type React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type Props = {
  tooltip: string;
  onClick: (e: React.MouseEvent) => void;
} & Omit<ButtonProps, "onClick">;

export function TooltipButton({
  children,
  tooltip,
  onClick,
  variant = "outline",
  size = "icon-sm",
  disabled,
  ...props
}: Props) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {disabled ? (
          <span className="cursor-not-allowed">
            <Button disabled variant={variant} size={size} {...props}>
              {children}
            </Button>
          </span>
        ) : (
          <Button
            variant={variant}
            size={size}
            onClick={(e) => {
              e.stopPropagation();
              onClick(e);
            }}
            {...props}
          >
            {children}
          </Button>
        )}
      </TooltipTrigger>
      <TooltipContent className="max-w-60">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
