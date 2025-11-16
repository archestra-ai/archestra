import { archestraApiSdk, type Permissions } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { authClient } from "@/lib/clients/auth/auth-client";

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
      const { data } = await archestraApiSdk.hasPermission({
        body: { permissions: permissionsToCheck },
      });

      if (!data?.success) {
        // Create a readable list of missing permissions
        const permissionsList = Object.entries(permissionsToCheck)
          .flatMap(([resource, actions]) =>
            actions.map((action) => `${resource}:${action}`),
          )
          .join(", ");

        toast.error("Permission Denied", {
          description: `You are missing required permissions: ${permissionsList}`,
        });

        return false;
      }

      return true;
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
