import type { Permissions } from "@shared";
import { authClient } from "./clients/auth/auth-client";

export function useIsAuthenticated() {
  const session = authClient.useSession();
  return session.data?.user != null;
}

export function hasPermissions(permissions: Permissions) {
  return authClient.organization.hasPermission({
    permissions,
  });
}
