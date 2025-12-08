import { archestraApiSdk } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { use } from "react";
import config from "@/lib/config";
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
type Permissions = Record<string, string[]>;

/**
 * Checks user permissions, resolving to true or false.
 * Under the hood, fetches all user permissions and re-uses this permission cache.
 *
 * Free version: Always returns true (no RBAC enforcement)
 * EE version: Performs actual permission checks
 */
export function useHasPermissions(
  permissionsToCheck: Permissions,
) {
  const { useHasPermissions } = use(
    config.enterpriseLicenseActivated
      // biome-ignore lint/style/noRestrictedImports: EE-only permission hook
      ? import("./auth.query.ee")
      : Promise.resolve({
          useHasPermissions: () => ({
            data: true,
            isLoading: false,
            isError: false,
            error: null,
            isSuccess: true,
            status: "success" as const,
          }),
        }),
  );
  return useHasPermissions(permissionsToCheck);
}

/**
 * Resolves the permission map with given keys and results of permission checks as values.
 * Use in cases where multiple useHasPermissions calls are impossible.
 *
 * Free version: Always returns true for all keys (no RBAC enforcement)
 * EE version: Performs actual permission checks for each key
 */
export function usePermissionMap<Key extends string>(
  map: Record<Key, Permissions>,
): Record<Key, boolean> {
  const { usePermissionMap } = use(
    config.enterpriseLicenseActivated
      // biome-ignore lint/style/noRestrictedImports: EE-only permission hook
      ? import("./auth.query.ee")
      : Promise.resolve({
          usePermissionMap: <Key extends string>(
            _map: Record<Key, Permissions>,
          ): Record<Key, boolean> => {
            return Object.keys(_map).reduce(
              (acc, key) => {
                acc[key] = true;
                return acc;
              },
              {},
            );
          },
        }),
  );
  return usePermissionMap(map);
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
