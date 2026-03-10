import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useIsAuthenticated } from "./auth.hook";
import { DEFAULT_TABLE_LIMIT, handleApiError } from "./utils";

const { getRoles, createRole, getRole, updateRole, deleteRole } =
  archestraApiSdk;

/**
 * Query keys for role-related queries
 */
export const roleKeys = {
  all: ["roles"] as const,
  lists: () => [...roleKeys.all, "list"] as const,
  paginated: (params?: Record<string, unknown>) =>
    [...roleKeys.all, "paginated", params] as const,
  details: () => [...roleKeys.all, "detail"] as const,
  detail: (id: string) => [...roleKeys.details(), id] as const,
  custom: () => [...roleKeys.all, "custom"] as const,
};

/**
 * Hook to fetch all roles for the organization (flat array, for dropdowns/selects)
 */
export function useRoles(params?: {
  initialData?: archestraApiTypes.GetRolesResponses["200"]["data"];
}) {
  return useQuery({
    queryKey: roleKeys.lists(),
    queryFn: async () => {
      const { data, error } = await getRoles({
        query: { limit: 1000 },
      });
      if (error) {
        handleApiError(error);
        return [];
      }
      return data?.data ?? [];
    },
    initialData: params?.initialData,
  });
}

/**
 * Hook to fetch paginated roles for the DataTable
 */
export function useRolesPaginated(params?: {
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDirection?: string;
  search?: string;
}) {
  return useQuery({
    queryKey: roleKeys.paginated(params as Record<string, unknown>),
    queryFn: async () => {
      const { data, error } = await getRoles({
        query: {
          limit: params?.limit ?? DEFAULT_TABLE_LIMIT,
          offset: params?.offset ?? 0,
          sortBy: params?.sortBy as "name" | "createdAt" | undefined,
          sortDirection: params?.sortDirection as "asc" | "desc" | undefined,
          search: params?.search,
        },
      });
      if (error) {
        handleApiError(error);
        return {
          data: [],
          pagination: {
            currentPage: 1,
            limit: 20,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        };
      }
      return data;
    },
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
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: roleKeys.all });
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
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: roleKeys.all });
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
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: roleKeys.all });
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
      const { data, error } = await archestraApiSdk.getRoles({
        query: { limit: 1000 },
      });
      if (error) {
        handleApiError(error);
        return [];
      }
      if (!data) return [];

      // Filter to only custom roles (non-predefined)
      return data.data.filter((role) => !role.predefined);
    },
    enabled: userIsAuthenticated,
    retry: false,
    throwOnError: false,
  });
}
