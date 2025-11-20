/**
 * Abstract wrapper component that adds permission-based access control to any button.
 * Wraps in its own tooltip or reuses the existing one.
 * Note: Does not play well in the tooltip trigger, e.g.:
 * <TooltipTrigger><WithPermission><Button /></WithPermission></TooltipTrigger>.
 *
 * @example
 * <WithPermissions permissions={{ profile: ["update"] }}>
 *   <Button onClick={handleEdit}>
 *     <Pencil className="h-4 w-4" />
 *   </Button>
 * </WithPermissions>
 */

import type { Permissions } from "@shared";
import React from "react";
import type { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { TooltipButton } from "@/components/ui/tooltip-button";
import { useHasPermissions } from "@/lib/auth.query";
import { cn } from "@/lib/utils";

type ButtonInstance = React.ReactElement<React.ComponentProps<typeof Button>>;
type TooltipButtonInstance = React.ReactElement<
  React.ComponentProps<typeof TooltipButton>
>;

type WithPermissionsProps = {
  children: ButtonInstance | TooltipButtonInstance;
  permissions: Permissions;
};

/**
 * Type guard to check if element has an 'tooltip' prop (TooltipButton)
 */
function isTooltipButton(
  props:
    | React.ComponentProps<typeof Button>
    | React.ComponentProps<typeof TooltipButton>,
): props is React.ComponentProps<typeof TooltipButton> {
  return "tooltip" in props;
}

/**
 * Convert Permissions object to array of permission strings
 */
function permissionsToStrings(permissions: Permissions): string[] {
  const result: string[] = [];
  for (const [resource, actions] of Object.entries(permissions)) {
    for (const action of actions) {
      result.push(`${resource}:${action}`);
    }
  }
  return result;
}

export function WithPermissions({
  children,
  permissions,
}: WithPermissionsProps) {
  const { data: hasPermission } = useHasPermissions(permissions);
  if (hasPermission) {
    return children;
  }

  const withoutHover = children.props.className
    ? children.props.className
        .split(" ")
        .filter((cls) => !cls.startsWith("hover:"))
        .join(" ")
    : "";

  // Disable the button and wrap in span for tooltip
  const props = {
    ...children.props,
    disabled: true,
    className: cn(withoutHover, "opacity-50"),
  };

  const permissionError = `Missing permissions: ${permissionsToStrings(permissions).join(", ")}`;

  // If it's an TooltipButton with an tooltip prop, append permission error to it
  if (isTooltipButton(children.props)) {
    const updatedProps = {
      ...props,
      tooltip: `"${children.props.tooltip}" action is disabled. ${permissionError}.`,
    };
    return React.cloneElement(children, updatedProps);
  } else {
    const disabledButton = React.cloneElement(children, props);
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-not-allowed">{disabledButton}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-60">{`This action is disabled. ${permissionError}.`}</TooltipContent>
      </Tooltip>
    );
  }
}
