import {
  type Action,
  archestraApiSdk,
  type Permission,
  type Resource,
} from "@shared";
import { useQuery } from "@tanstack/react-query";
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

      try {
        const { data } = await authClient.organization.hasPermission({
          permissions: permissionsMap,
        });
        return data?.success ?? false;
      } catch (error) {
        // If permission check fails due to auth issues (common in older WebKit),
        // invalidate session cache to trigger re-authentication
        if (
          error instanceof Error &&
          (error.message.includes("401") ||
            error.message.includes("Unauthorized") ||
            error.message.includes("authentication"))
        ) {
          console.warn(
            "Permission check failed due to authentication issue, invalidating session cache",
          );
          // Force session refresh on next render
          await authClient.getSession();
          return false;
        }
        throw error;
      }
    },
    // Add retry logic for authentication failures
    retry: (failureCount, error) => {
      // Retry up to 2 times for auth-related errors
      if (
        failureCount < 2 &&
        error instanceof Error &&
        (error.message.includes("401") ||
          error.message.includes("Unauthorized") ||
          error.message.includes("authentication"))
      ) {
        return true;
      }
      return false;
    },
    retryDelay: 1000, // 1 second delay between retries
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
