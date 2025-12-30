import type { Permissions } from "@shared";
import type React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHasPermissions } from "@/lib/auth.query";
import { permissionsToStrings } from "@/lib/auth.utils";

type PermissionButtonProps = ButtonProps & {
  permissions: Permissions;
  tooltip?: string;
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
 *   permissions={{ tool: ["update"] }}
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
  ...props
}: PermissionButtonProps) {
  const { data: hasPermission } = useHasPermissions(permissions);

  if (hasPermission && tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button {...props}>{children}</Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-60">{tooltip}</TooltipContent>
      </Tooltip>
    );
  } else if (hasPermission) {
    return <Button {...props}>{children}</Button>;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-not-allowed">
          <Button
            onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
              // Prevent action when disabled
              e.preventDefault();
              e.stopPropagation();
            }}
            {...props}
            disabled
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-60">
        <p>
          Required permissions: {permissionsToStrings(permissions).join(", ")}.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
