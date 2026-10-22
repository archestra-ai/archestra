import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

const { getModelPools, createModelPool, updateModelPool, deleteModelPool } =
  archestraApiSdk;

export type ModelPool = archestraApiTypes.GetModelPoolsResponses["200"][number];
export type ModelPoolInput = archestraApiTypes.CreateModelPoolData["body"];

const MODEL_POOLS_QUERY_KEY = ["model-pools"] as const;

/**
 * The organization's pools. Refetched every few seconds while shown, because
 * a benched member comes back within a minute.
 */
export function useModelPools(options?: {
  enabled?: boolean;
  toastOnError?: boolean;
  refetchInterval?: number;
}) {
  return useQuery({
    queryKey: MODEL_POOLS_QUERY_KEY,
    enabled: options?.enabled,
    refetchInterval: options?.refetchInterval,
    queryFn: async () => {
      const { data, error } = await getModelPools();
      throwOnApiError(error, { toastOnError: options?.toastOnError });
      return data ?? [];
    },
  });
}

export function useCreateModelPool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: ModelPoolInput) => {
      const { data, error } = await createModelPool({ body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Model pool created");
      queryClient.invalidateQueries({ queryKey: MODEL_POOLS_QUERY_KEY });
    },
  });
}

export function useUpdateModelPool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: ModelPoolInput }) => {
      const { data, error } = await updateModelPool({ path: { id }, body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Model pool saved");
      queryClient.invalidateQueries({ queryKey: MODEL_POOLS_QUERY_KEY });
    },
  });
}

export function useDeleteModelPool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await deleteModelPool({ path: { id } });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Model pool deleted");
      queryClient.invalidateQueries({ queryKey: MODEL_POOLS_QUERY_KEY });
    },
  });
}
