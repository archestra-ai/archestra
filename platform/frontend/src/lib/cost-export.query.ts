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
    llmCost: ["read"],
    organizationSettings: ["read"],
  });
  return useQuery({
    queryKey: costExportKeys.list(),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listCostExports();
      throwOnApiError(error);
      return data ?? [];
    },
    enabled: !!canRead,
  });
}

export function useCreateCostExport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateCostExportBody) => {
      const { data, error } = await archestraApiSdk.createCostExport({ body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
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
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
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

export function useRunCostExport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await archestraApiSdk.runCostExport({
        path: { id },
      });
      // Failed runs are recorded on the export, so refresh either way.
      queryClient.invalidateQueries({ queryKey: costExportKeys.all });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (result) => {
      const rows = result.files.reduce((sum, file) => sum + file.rows, 0);
      toast.success(
        `Wrote ${result.files.length} file${result.files.length === 1 ? "" : "s"}`,
        {
          description: `${rows} row${rows === 1 ? "" : "s"} · ${result.files.at(-1)?.location ?? ""}`,
        },
      );
    },
  });
}
