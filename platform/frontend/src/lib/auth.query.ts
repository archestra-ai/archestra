import { archestraApiSdk, type Permissions } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { hasPermission } from "./auth.utils";

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

export function useHasPermissions(permissionsToCheck: Permissions) {
  return useQuery({
    queryKey: ["auth", "hasPermission", JSON.stringify(permissionsToCheck)],
    queryFn: async () => {
      return hasPermission(permissionsToCheck);
    },
  });
}

export function useDefaultCredentialsEnabled() {
  return useQuery({
    queryKey: ["auth", "defaultCredentialsEnabled"],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getDefaultCredentialsStatus();
      return data?.enabled ?? false;
    },
    // Refetch when window is focused to catch password changes
    refetchOnWindowFocus: true,
    // Keep data fresh with shorter stale time
    staleTime: 10000, // 10 seconds
  });
}
