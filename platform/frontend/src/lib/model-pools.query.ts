import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { runBulkAction } from "@/lib/bulk-action";
import { useFeature } from "@/lib/config/config.query";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

const {
  getModelPools,
  getAvailableModelPools,
  createModelPool,
  updateModelPool,
  deleteModelPool,
} = archestraApiSdk;

export type ModelPool = archestraApiTypes.GetModelPoolsResponses["200"][number];
export type ModelPoolInput = archestraApiTypes.CreateModelPoolData["body"];
export type AvailableModelPool =
  archestraApiTypes.GetAvailableModelPoolsResponses["200"][number];

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

/**
 * The pools the viewer can pick in chat: those with a member on a key they may
 * use. Empty while model pools are off.
 */
export function useAvailableModelPools(options?: { enabled?: boolean }) {
  const enabled = useFeature("llmModelPoolsEnabled") === true;
  return useQuery({
    queryKey: [...MODEL_POOLS_QUERY_KEY, "available"],
    enabled: enabled && options?.enabled !== false,
    queryFn: async () => {
      const { data, error } = await getAvailableModelPools();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

/**
 * Whether a provider's model is served by a pool: a request for a pool's name
 * on a provider with a member goes to the pool. Always false while model
 * pools are off or the viewer can't read them.
 */
export function useIsPooledModel(active = true) {
  const enabled = useFeature("llmModelPoolsEnabled") === true;
  const { data: canRead } = useHasPermissions({ llmModel: ["read"] });
  const { data: pools } = useModelPools({
    enabled: active && enabled && canRead === true,
    toastOnError: false,
  });
  return useMemo(() => {
    const pooled = new Set(
      (pools ?? []).flatMap((pool) =>
        pool.members.map((member) => `${member.provider}:${pool.name}`),
      ),
    );
    return (provider: string, modelId: string) =>
      active && pooled.has(`${provider}:${modelId}`);
  }, [pools, active]);
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

/**
 * Deletes several pools. There is no bulk pool endpoint, so this fans out over
 * the per-pool route and reports one outcome instead of a toast per pool.
 */
export function useBulkDeleteModelPools() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pools: readonly ModelPool[]) =>
      runBulkAction({
        items: pools,
        describe: (pool) => pool.name,
        run: async (pool) => {
          const { error } = await deleteModelPool({ path: { id: pool.id } });
          throwOnApiError(error, { toastOnError: false });
        },
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: MODEL_POOLS_QUERY_KEY });
    },
  });
}
