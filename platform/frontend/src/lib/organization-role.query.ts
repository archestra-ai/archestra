import { archestraApiSdk } from "@shared";
import { useQuery } from "@tanstack/react-query";

/**
 * Query key factory for organization role-related queries
 */
export const organizationRoleKeys = {
  all: ["organizationRoles"] as const,
  roles: () => [...organizationRoleKeys.all, "roles"] as const,
};

/**
 * Fetch all roles (including predefined and custom) for the current organization
 */
export function useRoles() {
  return useQuery({
    queryKey: organizationRoleKeys.roles(),
    queryFn: async () => {
      const { data } = await archestraApiSdk.getRoles();
      return data || [];
    },
    retry: false, // Don't retry on permission errors
    throwOnError: false, // Don't throw errors to prevent crashes
  });
}

/**
 * Get custom roles for better-auth UI components
 * Filters out predefined roles and returns only custom ones
 */
export function useCustomRoles() {
  return useQuery({
    queryKey: [...organizationRoleKeys.roles(), "custom"],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getRoles();
      if (!data) return [];

      // Filter to only custom roles (non-predefined)
      return data.filter((role) => !role.predefined);
    },
    retry: false,
    throwOnError: false,
  });
}
