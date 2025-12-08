import { archestraApiSdk, type Permissions } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { useIsAuthenticated } from "@/lib/auth.hook";

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
 * Resolves the permission map with given keys and results of permission checks as values.
 * Use in cases where multiple useHasPermissions calls are impossible.
 */
export function usePermissionMap<Key extends string>(
  map: Record<Key, Permissions>,
): Record<Key, boolean> {
  const { data: userPermissions } = useAllPermissions();

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
