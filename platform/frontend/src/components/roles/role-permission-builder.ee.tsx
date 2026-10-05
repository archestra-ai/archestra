"use client";

import type { Permissions } from "@archestra/shared";
import { PermissionExplorer } from "@/components/permission-explorer";

export function RolePermissionBuilder({
  permission,
  onChange,
  userPermissions,
  readOnly = false,
}: {
  permission: Permissions;
  onChange: (permission: Permissions) => void;
  userPermissions: Permissions;
  readOnly?: boolean;
}) {
  return (
    <PermissionExplorer
      permissions={permission}
      onChange={readOnly ? undefined : onChange}
      grantable={userPermissions}
    />
  );
}
