import type { Permissions } from "@shared";
import type React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import { formatMissingPermissions } from "@/lib/auth/auth.utils";
import { cn } from "@/lib/utils";

type PermissionButtonProps = ButtonProps & {
  permissions: Permissions;
  tooltip?: string;
  noPermissionHandle?: "tooltip" | "hide";
};

/**
 * A Button component with built-in permission checking and tooltip.
 * When user has permission, shows the button as is.
 * When user lacks permission, shows permission error tooltip and disables the button.
 * Note the extra html element which is wrapped around the button when it's disabled.
 * This element receives pointer events so that the tooltip trigger works with the disabled button.
 *
 * @example
 * <PermissionButton
 *   permissions={{ toolPolicy: ["update"] }}
 *   onClick={handleAction}
 *   size="sm"
 *   variant="outline"
 * >
 *   Dual LLM
 * </PermissionButton>
 *
 * Note that the alternative approach, wrapping a Button into an abstract WithPermission component
 * doesn't play well with the radix.ui tooltip trigger in cases like:
 * <TooltipTrigger><WithPermission><Button /></WithPermission></TooltipTrigger>.
 */
export function PermissionButton({
  permissions,
  tooltip,
  children,
  noPermissionHandle = "tooltip",
  className,
  ...props
}: PermissionButtonProps) {
  const { data: hasPermission } = useHasPermissions(permissions);
  const missingPermissions = useMissingPermissions(permissions);

  if (hasPermission && tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={className}>
            <Button {...props} className={cn(className, "w-full")}>
              {children}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-60">{tooltip}</TooltipContent>
      </Tooltip>
    );
  } else if (hasPermission) {
    return (
      <Button {...props} className={className}>
        {children}
      </Button>
    );
  }

  if (noPermissionHandle === "hide") {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("cursor-not-allowed", className)}>
          <Button
            onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
              // Prevent action when disabled
              e.preventDefault();
              e.stopPropagation();
            }}
            {...props}
            className={cn(className, "w-full")}
            disabled
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-60">
        {tooltip || formatMissingPermissions(missingPermissions)}
      </TooltipContent>
    </Tooltip>
  );
}
