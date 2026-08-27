import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
type Role = archestraApiTypes.GetRolesResponses["200"]["data"][number];

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
 * Every role in the organization, for the pickers that assign one.
 *
 * This walks the pages rather than reading the first one: `/api/roles` serves
 * the four predefined roles ahead of the custom roles, so a single default-size
 * page left an organization seeing only its first six custom roles — in every
 * role picker at once, while the Roles settings page listed them all. That
 * reads as "the role I just made doesn't exist" rather than as a missing page.
 *
 * De-duplicated on `role`, the identifier the pickers use as an option value.
 * Two options sharing a value make a selection ambiguous, and there are two
 * ways to get there: a custom role whose generated identifier collides with a
 * predefined one (naming a role "Admin" yields `admin`), and a walk that races
 * a role being created, since a new name shifts the ordering under the offsets.
 * Predefined roles are served first and so win the collision.
 *
 * The walk still stops at `useAllMatching`'s ceiling, stated here rather than
 * inherited quietly, since an unstated ceiling is what this was. It sits far
 * above any workable number of roles: a picker listing a thousand of them has
 * problems that fetching the thousand-and-first would not fix.
 */
export function useRoles() {
  return useAllMatching<Role>({
    queryKey: [...roleKeys.lists()],
    max: 1000,
    fetchPage: async ({ limit, offset }) => {
      const response = await getRoles({ query: { limit, offset } });
      throwOnApiError(response.error, { toastOnError: false });
      return response.data?.data ?? [];
    },
    select: dedupeByRole,
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

// ===
// Internal helpers
// ===

function dedupeByRole(roles: Role[]): Role[] {
  const seen = new Set<string>();
  return roles.filter((role) => {
    if (seen.has(role.role)) return false;
    seen.add(role.role);
    return true;
  });
}
