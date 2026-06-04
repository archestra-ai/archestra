import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQuery } from "@tanstack/react-query";
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
