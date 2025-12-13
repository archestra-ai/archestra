import type { Permissions } from "@shared";
import { Button, type ButtonProps } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import config from "@/lib/config";

type PermissionButtonProps = ButtonProps & {
  permissions: Permissions;
  tooltip?: string;
};

const { PermissionButton: PermissionButtonEE } =
  config.enterpriseLicenseActivated
    ? // biome-ignore lint/style/noRestrictedImports: EE-only permission component
      await import("./permission-button.ee")
    : {
        PermissionButton: ({
          permissions: _permissions,
          tooltip,
          children,
          ...props
        }: PermissionButtonProps) => {
          // Free version: no permission checks, render button with optional tooltip
          if (tooltip) {
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button {...props}>{children}</Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-60">{tooltip}</TooltipContent>
              </Tooltip>
            );
          }
          return <Button {...props}>{children}</Button>;
        },
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
export function PermissionButton(props: PermissionButtonProps) {
  return <PermissionButtonEE {...props} />;
}
