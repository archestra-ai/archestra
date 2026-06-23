import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { handleApiError } from "@/lib/utils";

const { getRoles, createRole, getRole, updateRole, deleteRole } =
  archestraApiSdk;

type RolesQuery = NonNullable<archestraApiTypes.GetRolesData["query"]>;
type RolesPaginatedParams = Pick<RolesQuery, "limit" | "offset" | "name">;

/**
 * Query keys for role-related queries
 */
export const roleKeys = {
  all: ["roles"] as const,
  lists: () => [...roleKeys.all, "list"] as const,
  details: () => [...roleKeys.all, "detail"] as const,
  detail: (id: string) => [...roleKeys.details(), id] as const,
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
