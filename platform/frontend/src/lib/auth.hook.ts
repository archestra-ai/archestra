import type { Action, Permission, Resource, Role } from "@shared";
import { authClient } from "./clients/auth/auth-client";

export function useIsAuthenticated() {
  const session = authClient.useSession();
  return session.data?.user != null;
}

export function useRole() {
  // First check session data for role (available immediately after login)
  const session = authClient.useSession();
  const roleFromSession = session.data?.user?.role;

  // Fall back to organization API call if role not in session
  const { data } = authClient.useActiveMemberRole();
  const roleFromOrg = data?.role;

  // Prefer session role for immediate availability, fall back to org role
  return (roleFromSession || roleFromOrg) as Role;
}

export function useHasPermission(permission: Permission) {
  const [resource, action] = permission.split(":") as [Resource, Action];
  return authClient.organization.hasPermission({
    permissions: { [resource]: [action] },
  });
}
