import { archestraApiSdk, type Permissions } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { useIsAuthenticated } from "@/lib/auth.hook";
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

  // Compute permission check result
  const hasPermissionResult = (() => {
    // If no permissions to check, allow access
    if (!permissionsToCheck || Object.keys(permissionsToCheck).length === 0) {
      return true;
    }

    // If permissions not loaded yet, deny access
    if (!userPermissions) {
      return false;
    }

    // Check if user has all required permissions
    for (const [resource, actions] of Object.entries(permissionsToCheck)) {
      const userActions = userPermissions[resource as keyof Permissions];
      if (!userActions) {
        return false;
      }

      for (const action of actions) {
        if (!userActions.includes(action)) {
          return false;
        }
      }
    }

    return true;
  })();

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
 * Low-level query which fetches the dictionary of all user permissions.
 * Avoid using directly in components and use useHasPermissions instead.
 */
function useAllPermissions() {
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
    // If no permissions required, allow access
    if (!requiredPermissions || Object.keys(requiredPermissions).length === 0) {
      result[key] = true;
      continue;
    }

    // If permissions not loaded yet, deny access
    if (!userPermissions) {
      result[key] = false;
      continue;
    }

    // Check if user has all required permissions
    let hasAllPermissions = true;
    for (const [resource, actions] of Object.entries(requiredPermissions)) {
      const userActions = userPermissions[resource as keyof Permissions];
      if (!userActions) {
        hasAllPermissions = false;
        break;
      }

      for (const action of actions) {
        if (!userActions.includes(action)) {
          hasAllPermissions = false;
          break;
        }
      }

      if (!hasAllPermissions) break;
    }

    result[key] = hasAllPermissions;
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
