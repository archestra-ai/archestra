import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils";

const {
  getBatchAnalyses,
  getBatchAnalysis,
  createBatchAnalysis,
  updateBatchAnalysis,
  deleteBatchAnalysis,
  addBatchAnalysisRows,
  deleteBatchAnalysisRow,
  startBatchAnalysisRun,
  retryBatchAnalysisCell,
} = archestraApiSdk;

/**
 * How often the detail view re-reads while a run is in flight. Cells flip
 * status independently as workers finish them, so the grid needs to converge
 * without the user reloading; polling stops as soon as nothing is running.
 */
const RUNNING_POLL_INTERVAL_MS = 2000;

export type BatchAnalysisDetail = NonNullable<
  archestraApiTypes.GetBatchAnalysisResponses["200"]
>;

export type BatchAnalysisSummary = NonNullable<
  archestraApiTypes.GetBatchAnalysesResponses["200"]
>["data"][number];

// ===== Queries =====

export function useBatchAnalyses(params: {
  limit: number;
  offset: number;
  search?: string;
}) {
  return useQuery({
    queryKey: [
      "batch-analyses",
      "list",
      params.limit,
      params.offset,
      params.search ?? "",
    ],
    queryFn: async () => {
      const { data, error } = await getBatchAnalyses({ query: params });
      throwOnApiError(error);
      return data ?? null;
    },
    // Page-to-page navigation should not blank the table out from under the
    // user; hold the previous page until the next one lands.
    placeholderData: (previous) => previous,
  });
}

export function useBatchAnalysis(analysisId: string | undefined) {
  return useQuery({
    queryKey: ["batch-analyses", analysisId],
    queryFn: async () => {
      if (!analysisId) return null;
      const { data, error } = await getBatchAnalysis({ path: { analysisId } });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
    },
    enabled: !!analysisId,
    // Only poll while work is outstanding: a finished analysis is static, and
    // an idle grid polling forever is pure load on every open tab.
    refetchInterval: (query) => {
      const detail = query.state.data;
      if (!detail) return false;
      const runActive = detail.latestRun?.status === "running";
      const cellsOutstanding = detail.cells.some(
        (cell) => cell.status === "pending" || cell.status === "generating",
      );
      return runActive || cellsOutstanding ? RUNNING_POLL_INTERVAL_MS : false;
    },
  });
}

// ===== Mutations =====

export function useCreateBatchAnalysis() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.CreateBatchAnalysisData["body"],
    ) => {
      const { data, error } = await createBatchAnalysis({ body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["batch-analyses"] });
      toast.success("Analysis created");
    },
  });
}

export function useAddBatchAnalysisRows(analysisId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.AddBatchAnalysisRowsData["body"],
    ) => {
      const { data, error } = await addBatchAnalysisRows({
        path: { analysisId },
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["batch-analyses"] });
      const added = data?.rows?.length ?? 0;
      toast.success(added === 1 ? "1 row added" : `${added} rows added`);
    },
  });
}

export function useStartBatchAnalysisRun(analysisId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await startBatchAnalysisRun({
        path: { analysisId },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["batch-analyses"] });
      toast.success("Run started");
    },
  });
}

export function useRetryBatchAnalysisCell(analysisId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (cell: { rowId: string; columnKey: string }) => {
      const { data, error } = await retryBatchAnalysisCell({
        path: { analysisId, rowId: cell.rowId, columnKey: cell.columnKey },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["batch-analyses", analysisId],
      });
      toast.success("Cell queued for retry");
    },
  });
}

export function useDeleteBatchAnalysisRow(analysisId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (rowId: string) => {
      const { data, error } = await deleteBatchAnalysisRow({
        path: { analysisId, rowId },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["batch-analyses", analysisId],
      });
      toast.success("Row removed");
    },
  });
}

export function useUpdateBatchAnalysis() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      analysisId: string;
      body: NonNullable<archestraApiTypes.UpdateBatchAnalysisData["body"]>;
    }) => {
      const { data, error } = await updateBatchAnalysis({
        path: { analysisId: params.analysisId },
        body: params.body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["batch-analyses"] });
      toast.success("Analysis updated");
    },
  });
}

export function useDeleteBatchAnalysis() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (analysisId: string) => {
      const { data, error } = await deleteBatchAnalysis({
        path: { analysisId },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["batch-analyses"] });
      toast.success("Analysis deleted");
    },
  });
}
