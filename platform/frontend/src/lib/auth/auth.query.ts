import { archestraApiSdk, type Permissions } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { useIsAuthenticated } from "@/lib/auth/auth.hook";
import { hasPermissions } from "@/lib/auth/auth.utils";
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
  const isAuthenticated = useIsAuthenticated();

  return useQuery({
    queryKey: ["auth", "orgMembers"],
    queryFn: async () => {
      const { data } = await authClient.organization.listMembers();
      return data?.members ?? [];
    },
    enabled: isAuthenticated,
  });
}

/**
 * Checks user permissions, resolving to true or false.
 * Under the hood, fetches all user permissions and re-uses this permission cache.
 */
export function useHasPermissions(permissionsToCheck: Permissions) {
  const {
    data: userPermissions,
    isPending,
    isLoading,
    isError,
    error,
    isSuccess,
    status,
  } = useAllPermissions();

  const hasPermissionResult = hasPermissions(
    userPermissions,
    permissionsToCheck,
  );

  return {
    data: hasPermissionResult,
    isPending,
    isLoading,
    isError,
    error,
    isSuccess,
    status,
  };
}

/**
 * Returns only the permissions the user is missing from the required set.
 * Useful for showing specific missing permissions in tooltips.
 */
export function useMissingPermissions(
  requiredPermissions: Permissions,
): Permissions {
  const { data: userPermissions } = useAllPermissions();

  if (
    !requiredPermissions ||
    Object.keys(requiredPermissions).length === 0 ||
    !userPermissions
  ) {
    return requiredPermissions;
  }

  const missing: Permissions = {};

  for (const [resource, actions] of Object.entries(requiredPermissions)) {
    const userActions = userPermissions[resource as keyof Permissions] ?? [];
    const missingActions = actions.filter(
      (a) => !(userActions as readonly string[]).includes(a),
    );
    if (missingActions.length > 0) {
      missing[resource as keyof Permissions] = missingActions;
    }
  }

  return missing;
}

/**
 * Low-level query which fetches the dictionary of all user permissions.
 * Avoid using directly in components and use useHasPermissions instead.
 */
export function useAllPermissions() {
  const isAuthenticated = useIsAuthenticated();

  return useQuery({
    queryKey: ["auth", "userPermissions"],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getUserPermissions();
      return data;
    },
    retry: false,
    throwOnError: false,
    enabled: isAuthenticated,
  });
}

/**
 * Resolves the permission map with given keys and results of permission checks as values.
 * Use in cases where multiple useHasPermissions calls are impossible.
 * @returns A record with the same keys as the input map and boolean values indicating permission checks, or null if still loading.
 */
export function usePermissionMap<Key extends string>(
  map: Record<Key, Permissions>,
): Record<Key, boolean> | null {
  const { data: userPermissions, isLoading } = useAllPermissions();

  if (isLoading) {
    return null;
  }

  const result = {} as Record<Key, boolean>;

  for (const [key, requiredPermissions] of Object.entries(map) as [
    Key,
    Permissions,
  ][]) {
    result[key] = hasPermissions(userPermissions, requiredPermissions);
  }

  return result;
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
