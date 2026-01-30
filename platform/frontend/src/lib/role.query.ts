import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useIsAuthenticated } from "./auth.hook";
import { handleApiError } from "./utils";

const { getRoles, createRole, getRole, updateRole, deleteRole } =
  archestraApiSdk;

/**
 * Query keys for role-related queries
 */
export const roleKeys = {
  all: ["roles"] as const,
  lists: () => [...roleKeys.all, "list"] as const,
  details: () => [...roleKeys.all, "detail"] as const,
  detail: (id: string) => [...roleKeys.details(), id] as const,
  custom: () => [...roleKeys.all, "custom"] as const,
};

/**
 * Hook to fetch all roles for the organization
 */
export function useRoles(params?: {
  initialData?: archestraApiTypes.GetRolesResponses["200"];
}) {
  return useQuery({
    queryKey: roleKeys.lists(),
    queryFn: async () => (await getRoles()).data ?? [],
    initialData: params?.initialData,
  });
}

/**
 * Hook to fetch a specific role by ID
 */
export function useRole(roleId: string) {
  return useQuery({
    queryKey: roleKeys.detail(roleId),
    queryFn: async () => (await getRole({ path: { roleId } })).data ?? null,
    enabled: !!roleId,
  });
}

/**
 * Hook to create a new custom role
 */
export function useCreateRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: archestraApiTypes.CreateRoleData["body"]) => {
      const response = await createRole({ body: data });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: roleKeys.lists() });
      queryClient.invalidateQueries({ queryKey: roleKeys.custom() });
    },
  });
}

/**
 * Hook to update an existing custom role
 */
export function useUpdateRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      roleId,
      data,
    }: {
      roleId: string;
      data: archestraApiTypes.UpdateRoleData["body"];
    }) => {
      const response = await updateRole({
        path: { roleId },
        body: data,
      });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: roleKeys.lists() });
      queryClient.invalidateQueries({ queryKey: roleKeys.custom() });
      queryClient.invalidateQueries({
        queryKey: roleKeys.detail(variables.roleId),
      });
    },
  });
}

/**
 * Hook to delete a custom role
 */
export function useDeleteRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (roleId: string) => {
      const response = await deleteRole({ path: { roleId } });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: roleKeys.lists() });
      queryClient.invalidateQueries({ queryKey: roleKeys.custom() });
    },
  });
}

/**
 * Get custom roles for better-auth UI components
 * Filters out predefined roles and returns only custom ones
 */
export function useCustomRoles() {
  const userIsAuthenticated = useIsAuthenticated();
  return useQuery({
    queryKey: roleKeys.custom(),
    queryFn: async () => {
      const { data } = await archestraApiSdk.getRoles();
      if (!data) return [];

      // Filter to only custom roles (non-predefined)
      return data.filter((role) => !role.predefined);
    },
    enabled: userIsAuthenticated,
    retry: false,
    throwOnError: false,
  });
}
