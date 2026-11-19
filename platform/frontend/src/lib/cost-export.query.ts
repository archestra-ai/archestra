import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

export type CostExport =
  archestraApiTypes.ListCostExportsResponses["200"][number];
export type CreateCostExportBody =
  archestraApiTypes.CreateCostExportData["body"];
export type UpdateCostExportBody =
  archestraApiTypes.UpdateCostExportData["body"];

export const costExportKeys = {
  all: ["cost-exports"] as const,
  list: () => [...costExportKeys.all, "list"] as const,
};

export function useCostExports() {
  const { data: canRead } = useHasPermissions({
    costExport: ["read"],
  });
  return useQuery({
    queryKey: costExportKeys.list(),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listCostExports();
      throwOnApiError(error);
      return data ?? [];
    },
    enabled: !!canRead,
    // Runs happen on the task queue: poll while one is queued or running so
    // the row shows its outcome.
    refetchInterval: (query) =>
      query.state.data?.some((costExport) => costExport.running)
        ? RUNNING_POLL_MS
        : false,
  });
}

export function useCreateCostExport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateCostExportBody) => {
      const { data, error } = await archestraApiSdk.createCostExport({ body });
      // The dialog shows the failure inline.
      if (error) throw toApiError(error);
      return data;
    },
    onSuccess: (costExport) => {
      queryClient.invalidateQueries({ queryKey: costExportKeys.all });
      toast.success(`${costExport.name} scheduled`);
    },
  });
}

export function useUpdateCostExport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; body: UpdateCostExportBody }) => {
      const { data, error } = await archestraApiSdk.updateCostExport({
        path: { id: params.id },
        body: params.body,
      });
      // The dialog shows the failure inline.
      if (error) throw toApiError(error);
      return data;
    },
    onSuccess: (costExport) => {
      queryClient.invalidateQueries({ queryKey: costExportKeys.all });
      toast.success(`${costExport.name} updated`);
    },
  });
}

export function useDeleteCostExport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await archestraApiSdk.deleteCostExport({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: costExportKeys.all });
      toast.success("Cost export deleted");
    },
  });
}

/** Pause or resume one export, for bulk actions (no toast). */
export async function setCostExportEnabled(params: {
  id: string;
  enabled: boolean;
}) {
  const { error } = await archestraApiSdk.updateCostExport({
    path: { id: params.id },
    body: { enabled: params.enabled },
  });
  throwOnApiError(error, { toastOnError: false });
}

/** Delete one export, for bulk actions (no toast). */
export async function deleteCostExport(id: string) {
  const { error } = await archestraApiSdk.deleteCostExport({ path: { id } });
  throwOnApiError(error, { toastOnError: false });
}

export function useRunCostExport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await archestraApiSdk.runCostExport({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    // Queued (202): the row shows "Running…" and then the outcome.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: costExportKeys.all }),
  });
}

const RUNNING_POLL_MS = 3000;
