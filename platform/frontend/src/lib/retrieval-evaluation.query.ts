import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError } from "./utils";

export const retrievalEvaluationKeys = {
  all: ["retrieval-evaluations"] as const,
  capabilities: () => [...retrievalEvaluationKeys.all, "capabilities"] as const,
  capabilitiesPreview: (
    settingsOverrides: archestraApiTypes.PreviewRetrievalEvaluationCapabilitiesData["body"],
  ) =>
    [
      ...retrievalEvaluationKeys.capabilities(),
      "preview",
      settingsOverrides,
    ] as const,
  list: () => [...retrievalEvaluationKeys.all, "list"] as const,
  detail: (id: string | null) =>
    [...retrievalEvaluationKeys.all, "detail", id] as const,
  comparison: (beforeId: string | null, afterId: string | null) =>
    [...retrievalEvaluationKeys.all, "comparison", beforeId, afterId] as const,
};

export function useRetrievalEvaluationCapabilities() {
  return useQuery({
    queryKey: retrievalEvaluationKeys.capabilities(),
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.getRetrievalEvaluationCapabilities();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}

export function useRetrievalEvaluationCapabilitiesPreview(params: {
  settingsOverrides: archestraApiTypes.PreviewRetrievalEvaluationCapabilitiesData["body"];
  enabled: boolean;
}) {
  return useQuery({
    queryKey: retrievalEvaluationKeys.capabilitiesPreview(
      params.settingsOverrides,
    ),
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.previewRetrievalEvaluationCapabilities({
          body: params.settingsOverrides,
        });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    enabled: params.enabled,
  });
}

export function useRetrievalEvaluationRuns() {
  return useQuery({
    queryKey: retrievalEvaluationKeys.list(),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listRetrievalEvaluationRuns(
        {
          query: { limit: 10 },
        },
      );
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    refetchInterval: (query) =>
      query.state.data?.some((run) => isActive(run.status)) ? 2_000 : false,
  });
}

export function useRetrievalEvaluationRun(id: string | null) {
  return useQuery({
    queryKey: retrievalEvaluationKeys.detail(id),
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await archestraApiSdk.getRetrievalEvaluationRun({
        path: { id },
      });
      throwOnApiError(error, { allowNotFound: true, toastOnError: false });
      return data ?? null;
    },
    enabled: id !== null,
    refetchInterval: (query) =>
      query.state.data && isActive(query.state.data.status) ? 2_000 : false,
  });
}

export function useStartRetrievalEvaluation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.StartRetrievalEvaluationData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.startRetrievalEvaluation({
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: (run) => {
      if (!run) return;
      queryClient.setQueryData(retrievalEvaluationKeys.detail(run.id), run);
      queryClient.invalidateQueries({
        queryKey: retrievalEvaluationKeys.list(),
      });
      toast.success("Retrieval evaluation queued");
    },
  });
}

export function useCancelRetrievalEvaluation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await archestraApiSdk.cancelRetrievalEvaluation({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: (run) => {
      if (!run) return;
      queryClient.setQueryData(retrievalEvaluationKeys.detail(run.id), run);
      queryClient.invalidateQueries({
        queryKey: retrievalEvaluationKeys.list(),
      });
      toast.success(
        run.status === "cancelled"
          ? "Retrieval evaluation cancelled"
          : "Cancellation requested",
      );
    },
  });
}

export function useRetrievalEvaluationComparison(params: {
  beforeId: string | null;
  afterId: string | null;
}) {
  return useQuery({
    queryKey: retrievalEvaluationKeys.comparison(
      params.beforeId,
      params.afterId,
    ),
    queryFn: async () => {
      if (!params.beforeId || !params.afterId) return null;
      const { data, error } = await archestraApiSdk.compareRetrievalEvaluations(
        {
          path: { id: params.beforeId, otherId: params.afterId },
        },
      );
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    enabled:
      params.beforeId !== null &&
      params.afterId !== null &&
      params.beforeId !== params.afterId,
  });
}

function isActive(status: string): boolean {
  return ["queued", "running", "cancel_requested"].includes(status);
}
