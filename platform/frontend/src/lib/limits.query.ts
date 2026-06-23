import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

const { getLimits, createLimit, getLimit, updateLimit, deleteLimit } =
  archestraApiSdk;

type LimitsQuery = NonNullable<archestraApiTypes.GetLimitsData["query"]>;
type LimitsParams = Partial<LimitsQuery>;
type UpdateLimitParams = archestraApiTypes.UpdateLimitData["path"] &
  Partial<archestraApiTypes.UpdateLimitData["body"]>;
type DeleteLimitParams = archestraApiTypes.DeleteLimitData["path"];

export function useLimits(params?: LimitsParams) {
  return useQuery({
    queryKey: ["limits", params],
    queryFn: async () => {
      const response = await getLimits({
        query: params
          ? {
              ...(params.entityType && { entityType: params.entityType }),
              ...(params.entityId && { entityId: params.entityId }),
              ...(params.limitType && { limitType: params.limitType }),
            }
          : undefined,
      });
      return response.data ?? [];
    },
    // Automatically refetch every 5 seconds to keep usage data fresh
    refetchInterval: 5000,
    // Refetch when window regains focus
    refetchOnWindowFocus: true,
  });
}

export function useLimit(id: string) {
  return useQuery({
    queryKey: ["limits", id],
    queryFn: async () => {
      const response = await getLimit({ path: { id } });
      return response.data;
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
      await queryClient.invalidateQueries({ queryKey: ["limits"] });
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
      await queryClient.invalidateQueries({ queryKey: ["limits"] });
      await queryClient.invalidateQueries({
        queryKey: ["limits", variables.id],
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
      await queryClient.invalidateQueries({ queryKey: ["limits"] });
      queryClient.removeQueries({ queryKey: ["limits", variables.id] });
      toast.success("Limit deleted successfully");
    },
  });
}
