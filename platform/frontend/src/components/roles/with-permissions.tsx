import type { Permissions } from "@shared";
import type React from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHasPermissions, useMissingPermissions } from "@/lib/auth.query";
import { formatMissingPermissions } from "@/lib/auth.utils";

type WithPermissionsProps = {
  permissions: Permissions;
} & (
  | {
      noPermissionHandle: "tooltip";
      side?: "top" | "bottom" | "left" | "right";
      children: ({
        hasPermission,
      }: {
        hasPermission: boolean | undefined;
      }) => React.ReactNode;
    }
  | {
      noPermissionHandle: "hide";
      children: React.ReactNode;
      side?: never;
    }
);

export function WithPermissions({
  children,
  permissions,
  noPermissionHandle,
  side,
}: WithPermissionsProps) {
  const { data: hasPermission, isPending } = useHasPermissions(permissions);
  const missingPermissions = useMissingPermissions(permissions);

  // if has permission, return children as is
  if (hasPermission) {
    return typeof children === "function"
      ? children({ hasPermission: true })
      : children;
  }

  // if no permission and noPermissionHandle is 'hide', return null
  if (noPermissionHandle === "hide") {
    return null;
  }

  // if no permission and noPermissionHandle is 'tooltip', return a tooltip with the permission error
  if (noPermissionHandle === "tooltip") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="cursor-not-allowed">
            {children({ hasPermission: isPending ? undefined : false })}
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-60" side={side}>
          {formatMissingPermissions(missingPermissions)}
        </TooltipContent>
      </Tooltip>
    );
  }
}

export function WithoutPermissions({
  children,
  permissions,
}: {
  permissions: Permissions;
  children: React.ReactNode;
}) {
  const { data: hasPermission } = useHasPermissions(permissions);

  if (hasPermission) {
    return null;
  }

  return children;
}
