import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { toBulkOutcome } from "@/lib/bulk-action";
import { useAllMatching } from "@/lib/hooks/use-all-matching";
import { handleApiError, throwOnApiError } from "@/lib/utils";

const {
  getRoles,
  createRole,
  getRole,
  updateRole,
  deleteRole,
  bulkDeleteRoles,
} = archestraApiSdk;

type RolesQuery = NonNullable<archestraApiTypes.GetRolesData["query"]>;
type RolesPaginatedParams = Pick<RolesQuery, "limit" | "offset" | "name">;

/**
 * Query keys for role-related queries
 */
export const roleKeys = {
  all: ["roles"] as const,
  lists: () => [...roleKeys.all, "list"] as const,
  details: () => [...roleKeys.all, "detail"] as const,
  detail: (id: string | undefined) => [...roleKeys.details(), id] as const,
};

/**
 * Hook to fetch all roles for the organization
 */
export function useRoles(params?: {
  initialData?: archestraApiTypes.GetRolesResponses["200"]["data"];
}) {
  return useQuery({
    queryKey: roleKeys.lists(),
    queryFn: async () => {
      const response = await getRoles({
        query: { limit: DEFAULT_TABLE_LIMIT, offset: 0 },
      });
      throwOnApiError(response.error, { toastOnError: false });
      return response.data?.data ?? [];
    },
    initialData: params?.initialData,
  });
}

export function useRolesPaginated(params: RolesPaginatedParams) {
  return useQuery({
    queryKey: [...roleKeys.lists(), "paginated", params],
    queryFn: async () => {
      const response = await getRoles({ query: params });
      throwOnApiError(response.error, { toastOnError: false });
      return (
        response.data ?? {
          data: [],
          pagination: {
            currentPage: 1,
            limit: params.limit,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        }
      );
    },
  });
}

/**
 * Hook to fetch a specific role by ID
 */
export function useRole(roleId: string | undefined) {
  return useQuery({
    queryKey: roleKeys.detail(roleId),
    queryFn: async () => {
      if (!roleId) return null;
      const response = await getRole({ path: { roleId } });
      throwOnApiError(response.error, {
        allowNotFound: true,
        toastOnError: false,
      });
      return response.data ?? null;
    },
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
      queryClient.invalidateQueries({ queryKey: roleKeys.lists() });
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
    onSuccess: (data, variables) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: roleKeys.lists() });
      queryClient.invalidateQueries({
        queryKey: roleKeys.detail(variables.roleId),
      });
    },
  });
}

/**
 * Hook to delete a custom role
 */
/**
 * Deletes a selection of custom roles in one request. Predefined roles are
 * immutable, so the table never offers them; a role somebody still holds comes
 * back in `failed` with that reason while the rest are deleted.
 */
export function useBulkDeleteRoles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (roles: readonly { id: string; name: string }[]) =>
      bulkDeleteRoles({
        body: { ids: roles.map((role) => role.id) },
      }).then(({ data, error }) => {
        throwOnApiError(error, { toastOnError: false });
        return toBulkOutcome(data ?? { succeeded: [], failed: [] });
      }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: roleKeys.lists() }),
  });
}

/** Every role matching the table's filters, not just the page in view. */
export function useAllMatchingRoles(
  params: { search?: string },
  options?: { enabled?: boolean },
) {
  return useAllMatching({
    queryKey: [...roleKeys.lists(), "all-matching", params],
    enabled: options?.enabled,
    fetchPage: async ({ limit, offset }) => {
      const response = await getRoles({ query: { ...params, limit, offset } });
      throwOnApiError(response.error, { toastOnError: false });
      return response.data?.data ?? [];
    },
  });
}

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
      queryClient.invalidateQueries({ queryKey: roleKeys.lists() });
    },
  });
}
