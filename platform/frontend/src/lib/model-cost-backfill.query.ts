import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError } from "@/lib/utils/api";
import { browserTimeZone } from "@/lib/utils/time-zone";

const {
  previewModelCostBackfill,
  startModelCostBackfill,
  getModelCostBackfill,
} = archestraApiSdk;

export type ModelCostBackfillPreview =
  archestraApiTypes.PreviewModelCostBackfillResponses["200"];
export type ModelCostBackfillPrices = NonNullable<
  archestraApiTypes.PreviewModelCostBackfillData["body"]["prices"]
>;
export type ModelCostBackfill = NonNullable<
  archestraApiTypes.GetModelCostBackfillResponses["200"]
>;

/**
 * What recomputing a model's past costs would change, priced at `prices` (the
 * edit form's unsaved values). The previous answer stays on screen while a
 * new one loads, so typing a price doesn't blank the chart.
 */
export function useModelCostBackfillPreview(params: {
  modelId: string;
  prices: ModelCostBackfillPrices;
  since: Date | null;
  enabled: boolean;
}) {
  const timeZone = browserTimeZone();
  const since = params.since?.toISOString() ?? null;
  return useQuery({
    queryKey: [
      ...modelCostBackfillKey(params.modelId),
      "preview",
      timeZone,
      since,
      params.prices,
    ],
    queryFn: async () => {
      const { data, error } = await previewModelCostBackfill({
        path: { id: params.modelId },
        body: { timeZone, since, prices: params.prices },
      });
      throwOnApiError(error);
      return data ?? null;
    },
    enabled: params.enabled,
    placeholderData: keepPreviousData,
  });
}

/** The model's latest recompute; polls while one is in progress. */
export function useModelCostBackfill(params: {
  modelId: string;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: [...modelCostBackfillKey(params.modelId), "latest"],
    queryFn: async () => {
      const { data, error } = await getModelCostBackfill({
        path: { id: params.modelId },
      });
      throwOnApiError(error);
      return data ?? null;
    },
    enabled: params.enabled,
    refetchInterval: (query) =>
      isBackfillActive(query.state.data) ? ACTIVE_POLL_MS : false,
  });
}

export function useStartModelCostBackfill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      modelId: string;
      since: Date | null;
      prices?: ModelCostBackfillPrices;
    }) => {
      const { data, error } = await startModelCostBackfill({
        path: { id: params.modelId },
        body: {
          since: params.since?.toISOString() ?? null,
          prices: params.prices,
        },
      });
      // Null rather than a throw, like useUpdateModel: the edit dialog awaits
      // this inside its submit and keeps itself open when the start failed.
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, params) => {
      if (!data) return;
      toast.success("Recomputing past costs in the background");
      queryClient.invalidateQueries({
        queryKey: modelCostBackfillKey(params.modelId),
      });
    },
  });
}

export function isBackfillActive(
  backfill: ModelCostBackfill | null | undefined,
): boolean {
  return backfill?.status === "pending" || backfill?.status === "running";
}

// ===

const ACTIVE_POLL_MS = 2_000;

function modelCostBackfillKey(modelId: string) {
  return ["model-cost-backfill", modelId] as const;
}
