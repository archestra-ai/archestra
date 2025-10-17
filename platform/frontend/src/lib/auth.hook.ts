import type { Action, Permission, Resource, Role } from "@shared";
import { useEffect, useState } from "react";
import { authClient } from "./clients/auth/auth-client";

export function useIsAuthenticated() {
  const session = authClient.useSession();
  return session.data?.user != null;
}

export function useRole() {
  const { data } = authClient.useActiveMemberRole();
  return data?.role as Role;
}

export function useHasPermission(permission: Permission) {
  const [resource, action] = permission.split(":") as [Resource, Action];
  return authClient.organization.hasPermission({
    permissions: { [resource]: [action] },
  });
}

export function useHasPermissions(permissions: Permission[]) {
  const [hasPermissions, setHasPermissions] = useState(false);
  const permissionMap = permissions.reduce(
    (acc, permission) => {
      const [resource, action] = permission.split(":") as [Resource, Action];
      acc[resource] = [action];
      return acc;
    },
    {} as Record<Resource, Action[]>,
  );

  useEffect(() => {
    const checkPermissions = async () => {
      const result = await authClient.organization.hasPermission({
        permissions: permissionMap,
      });
      setHasPermissions(result.data?.success ?? false);
    };
    checkPermissions();
  }, [permissionMap]);

  return hasPermissions;
}
