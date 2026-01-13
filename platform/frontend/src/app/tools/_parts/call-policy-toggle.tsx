import { Ban, Check, Handshake } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CallPolicyAction } from "@/lib/policy.utils";

interface CallPolicyToggleProps {
  value: CallPolicyAction;
  onChange: (action: CallPolicyAction) => void;
  disabled?: boolean;
  size?: "sm" | "lg";
}

export function CallPolicyToggle({
  value,
  onChange,
  disabled,
  size = "sm",
}: CallPolicyToggleProps) {
  const isSmall = size === "sm";
  const buttonClass = isSmall ? "h-7 w-7 p-0" : "h-8 gap-1.5";

  const getButtonClassName = (action: CallPolicyAction) =>
    `${buttonClass} ${value === action ? "bg-background hover:bg-background border border-muted-foreground/30 shadow-xs rounded-md" : "bg-secondary hover:bg-secondary/80 border-0 text-foreground/50"}`;

  return (
    <div className="rounded-md bg-secondary p-[2px] flex gap-[1px]">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className={getButtonClassName("allow_when_context_is_untrusted")}
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                if (value !== "allow_when_context_is_untrusted") {
                  onChange("allow_when_context_is_untrusted");
                }
              }}
            >
              <Check className="h-3.5 w-3.5" />
              {!isSmall && "Allow always"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {isSmall
              ? "Allow always"
              : "Allow even when untrusted data is present"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className={getButtonClassName("block_when_context_is_untrusted")}
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                if (value !== "block_when_context_is_untrusted") {
                  onChange("block_when_context_is_untrusted");
                }
              }}
            >
              <Handshake className="h-3.5 w-3.5" />
              {!isSmall && "Allow in trusted context"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {isSmall
              ? "Allow in trusted context"
              : "Allow only when context contains no untrusted data"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className={getButtonClassName("block_always")}
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                if (value !== "block_always") {
                  onChange("block_always");
                }
              }}
            >
              <Ban className="h-3.5 w-3.5" />
              {!isSmall && "Block always"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {isSmall ? "Block always" : "Never allow this tool to be called"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
