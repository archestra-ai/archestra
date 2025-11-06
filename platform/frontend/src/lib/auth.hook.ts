import type { Action, Permission, Resource } from "@shared";
import { authClient } from "./clients/auth/auth-client";

export function useIsAuthenticated() {
  const session = authClient.useSession();
  return session.data?.user != null;
}

export function useHasPermission(permission: Permission) {
  const [resource, action] = permission.split(":") as [Resource, Action];
  return authClient.organization.hasPermission({
    permissions: { [resource]: [action] },
  });
}
