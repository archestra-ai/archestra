import type { Permissions } from "@archestra/shared";
import type React from "react";
import { isValidElement, useId } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  formatMissingPermissions,
  permissionResourceLabel,
} from "@/lib/auth/auth.utils";
import { cn } from "@/lib/utils/tailwind";

type PermissionButtonProps = ButtonProps & {
  permissions: Permissions;
  permissionScope?: string;
  tooltip?: string;
  noPermissionHandle?: "tooltip" | "hide";
};

/**
 * A Button component with built-in permission checking and tooltip.
 * When user has permission, shows the button as is.
 * When user lacks permission, shows the permission constraint and refuses to act.
 * A refused control is `aria-disabled` rather than `disabled`, so it keeps the
 * pointer events its own tooltip trigger needs and stays reachable by keyboard;
 * the refusal itself is enforced by the onClick guard, not by the attribute.
 * A caller that passes `disabled` with a `tooltip` is refusing the control for
 * a reason of its own (an ownership check the permission set cannot express),
 * so it is rendered the same way: natively disabling it would take the reason
 * out of reach of every user who cannot hover.
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
  permissionScope,
  tooltip,
  children,
  noPermissionHandle = "tooltip",
  className,
  ...props
}: PermissionButtonProps) {
  const {
    data: hasPermission,
    missingPermissions,
    isPending,
  } = useHasPermissions(permissions, permissionScope);
  const reasonId = useId();

  // An enabled control the caller holds the permission for: the tooltip is a
  // hover label, not a refusal.
  if (hasPermission && !props.disabled) {
    if (tooltip) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn("inline-flex", className)}>
              <Button {...props} className={className}>
                {children}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-60">{tooltip}</TooltipContent>
        </Tooltip>
      );
    }
    return (
      <Button {...props} className={className}>
        {children}
      </Button>
    );
  }

  if (!hasPermission && noPermissionHandle === "hide") {
    return null;
  }

  // `asChild` and `disabled` belong to the permitted rendering only: the first
  // would hand the caller's element (a link) the button's role, the second
  // would swallow the pointer events the tooltip trigger needs.
  const { asChild, disabled, ...rest } = props;
  // Permission failures win over loading or decorative action tooltips.
  const reason = !hasPermission
    ? isPending
      ? "Checking permissions…"
      : formatMissingPermissions(missingPermissions ?? permissions)
    : disabled && tooltip
      ? tooltip
      : undefined;

  if (!reason) {
    // Disabled by the caller with nothing said about why. There is no reason to
    // describe and no tooltip to open, so nothing is gained by keeping the
    // control focusable.
    return (
      <Button {...props} className={className}>
        {children}
      </Button>
    );
  }
  // There is nothing to navigate to when the action is refused, so only the
  // slot child's content survives; the link itself does not.
  const content =
    asChild && isValidElement<{ children?: React.ReactNode }>(children)
      ? children.props.children
      : children;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          {...rest}
          // After the spread on purpose: a caller's own onClick must not be
          // able to displace the refusal, and a caller's `type="submit"` must
          // not let a refused control submit the form it sits in.
          type="button"
          aria-disabled="true"
          aria-describedby={reasonId}
          className={className}
          onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {content}
          {/* The reason as text, not only as a tooltip: keyboard and screen
              reader users never open one. `aria-hidden` keeps it out of the
              accessible name, where it would duplicate the description a
              screen reader already reads from `aria-describedby`. */}
          <span id={reasonId} aria-hidden="true" className="sr-only">
            {reason}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        {!hasPermission && !isPending ? (
          <div>
            <span className="font-medium">Missing permissions</span>
            <ul className="mt-1 space-y-0.5">
              {Object.entries(missingPermissions ?? permissions).map(
                ([resource, actions]) => (
                  <li key={resource}>
                    <span>{permissionResourceLabel(resource)}</span>
                    <span className="opacity-75">{`: ${actions.join(", ")}`}</span>
                  </li>
                ),
              )}
            </ul>
          </div>
        ) : (
          reason
        )}
      </TooltipContent>
    </Tooltip>
  );
}
