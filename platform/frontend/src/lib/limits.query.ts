import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError } from "@/lib/utils";

const { getLimits, createLimit, getLimit, updateLimit, deleteLimit } =
  archestraApiSdk;

type UpdateLimitParams = archestraApiTypes.UpdateLimitData["path"] &
  Partial<archestraApiTypes.UpdateLimitData["body"]>;
type DeleteLimitParams = archestraApiTypes.DeleteLimitData["path"];

// The "list"/"detail" segments keep the two queries in separate cache entries.
// Without them an id-less detail query and the unfiltered list hash alike, and
// a mutation's refetch resolves the shared entry with whichever queryFn was
// applied last — overwriting the list array with the detail query's null.
export const limitKeys = {
  all: ["limits"] as const,
  lists: () => [...limitKeys.all, "list"] as const,
  details: () => [...limitKeys.all, "detail"] as const,
  detail: (id: string | undefined) => [...limitKeys.details(), id] as const,
};

export function useLimits() {
  return useQuery({
    queryKey: limitKeys.lists(),
    queryFn: async () => {
      const { data, error } = await getLimits();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    // Automatically refetch every 5 seconds to keep usage data fresh
    refetchInterval: 5000,
    // Refetch when window regains focus
    refetchOnWindowFocus: true,
  });
}

export function useLimit(id: string | undefined) {
  return useQuery({
    queryKey: limitKeys.detail(id),
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await getLimit({ path: { id } });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
    },
    enabled: !!id,
  });
}

export function useCreateLimit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: archestraApiTypes.CreateLimitData["body"]) => {
      const { data, error } = await createLimit({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: async (result) => {
      if (!result) return;
      await queryClient.invalidateQueries({ queryKey: limitKeys.all });
      toast.success("Limit created successfully");
    },
  });
}

export function useUpdateLimit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: UpdateLimitParams) => {
      const { data, error } = await updateLimit({ path: { id }, body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: async (result, variables) => {
      if (!result) return;
      await queryClient.invalidateQueries({ queryKey: limitKeys.all });
      await queryClient.invalidateQueries({
        queryKey: limitKeys.detail(variables.id),
      });
      toast.success("Limit updated successfully");
    },
  });
}

export function useDeleteLimit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: DeleteLimitParams) => {
      const { data, error } = await deleteLimit({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? { success: true };
    },
    onSuccess: async (result, variables) => {
      if (!result) return;
      await queryClient.invalidateQueries({ queryKey: limitKeys.all });
      queryClient.removeQueries({ queryKey: limitKeys.detail(variables.id) });
      toast.success("Limit deleted successfully");
    },
  });
}
