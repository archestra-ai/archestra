import { useQuery } from "@tanstack/react-query";
import { authClient } from "@/lib/clients/auth/auth-client";
import type { Action, Permission, Resource } from "../../../shared";
import { getDefaultCredentialsStatus } from "./clients/api";

/**
 * Fetch current session
 */
export function useSession() {
  return useQuery({
    queryKey: ["auth", "session"],
    queryFn: async () => {
      const { data } = await authClient.getSession();
      return data;
    },
  });
}

export function useCurrentOrgMembers() {
  return useQuery({
    queryKey: ["auth", "orgMembers"],
    queryFn: async () => {
      const { data } = await authClient.organization.listMembers();
      return data?.members ?? [];
    },
  });
}

export function useHasPermissions(permissionsToCheck: Permission[]) {
  return useQuery({
    queryKey: ["auth", "hasPermission", ...permissionsToCheck],
    queryFn: async () => {
      const permissionsMap = permissionsToCheck.reduce(
        (acc, permission) => {
          const [resource, action] = permission.split(":") as [
            Resource,
            Action,
          ];
          acc[resource] = [action];
          return acc;
        },
        {} as Record<Resource, Action[]>,
      );
      const { data } = await authClient.organization.hasPermission({
        permissions: permissionsMap,
      });
      return data?.success ?? false;
    },
  });
}

export function useDefaultCredentialsEnabled() {
  return useQuery({
    queryKey: ["auth", "defaultCredentialsEnabled"],
    queryFn: async () => {
      const { data } = await getDefaultCredentialsStatus();
      return data?.enabled ?? false;
    },
    // Refetch when window is focused to catch password changes
    refetchOnWindowFocus: true,
    // Keep data fresh with shorter stale time
    staleTime: 10000, // 10 seconds
  });
}
