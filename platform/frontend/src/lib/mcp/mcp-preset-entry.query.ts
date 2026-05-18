import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

export const mcpPresetEntryKeys = {
  all: ["mcp-preset-entries"] as const,
  list: () => [...mcpPresetEntryKeys.all, "list"] as const,
};

export type McpPresetEntryWithAssignedCount =
  archestraApiTypes.ListMcpPresetEntriesResponses["200"][number];

export function useMcpPresetEntries(enabled = true) {
  return useQuery({
    queryKey: mcpPresetEntryKeys.list(),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listMcpPresetEntries();
      if (error) {
        handleApiError(error);
        return [] as McpPresetEntryWithAssignedCount[];
      }
      return data ?? [];
    },
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateMcpPresetEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.CreateMcpPresetEntryData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.createMcpPresetEntry({
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (entry) => {
      if (!entry) return;
      queryClient.invalidateQueries({ queryKey: mcpPresetEntryKeys.list() });
      toast.success(`${entry.name} added`);
    },
  });
}

export function useDeleteMcpPresetEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await archestraApiSdk.deleteMcpPresetEntry({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (_data, _id) => {
      queryClient.invalidateQueries({ queryKey: mcpPresetEntryKeys.list() });
      // Catalog children with the matching presetEntryId were cascade-deleted.
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
      queryClient.invalidateQueries({ queryKey: ["internal-mcp-catalog"] });
      toast.success("Entry deleted");
    },
  });
}
