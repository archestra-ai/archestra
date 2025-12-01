import type { Permissions } from "@shared";
import type React from "react";
import type { ReactElement } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHasPermissions } from "@/lib/auth.query";
import { permissionsToStrings } from "@/lib/auth.utils";

type WithPermissionsProps = {
  permissions: Permissions;
} & (
  | {
      noPermissionHandle: "tooltip";
      children: ({ isDisabled }: { isDisabled: boolean }) => ReactElement;
    }
  | {
      noPermissionHandle: "hide";
      children: React.ReactNode;
    }
);

export function WithPermissions({
  children,
  permissions,
  noPermissionHandle,
}: WithPermissionsProps) {
  const { data: hasPermission } = useHasPermissions(permissions);

  // if has permission, return children as is
  if (hasPermission) {
    return typeof children === "function"
      ? children({ isDisabled: false })
      : children;
  }

  // if no permission and noPermissionHandle is 'hide', return null
  if (noPermissionHandle === "hide") {
    return null;
  }

  // if no permission and noPermissionHandle is 'tooltip', return a tooltip with the permission error
  if (noPermissionHandle === "tooltip") {
    const permissionError = `Missing permissions: ${permissionsToStrings(permissions).join(", ")}`;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-not-allowed">
            {children({ isDisabled: true })}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-60">{`${permissionError}.`}</TooltipContent>
      </Tooltip>
    );
  }
}
