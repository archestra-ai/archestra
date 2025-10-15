import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  type GetToolsData,
  type GetToolsResponses,
  getTools,
  type UpdateToolData,
  updateTool,
} from "@/lib/clients/api";

export function useTools({
  limit,
  offset,
  sortBy,
  sortDirection,
  initialData,
}: {
  limit?: number;
  offset?: number;
  sortBy?: NonNullable<GetToolsData["query"]>["sortBy"];
  sortDirection?: NonNullable<GetToolsData["query"]>["sortDirection"];
  initialData?: GetToolsResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["tools", { limit, offset, sortBy, sortDirection }],
    queryFn: async () => {
      if (limit !== undefined || offset !== undefined) {
        return (
          (await getTools({ query: { limit, offset, sortBy, sortDirection } }))
            .data ?? null
        );
      }
      return (await getTools()).data ?? null;
    },
    initialData,
    refetchInterval: 3_000, // later we might want to switch to websockets or sse, polling for now
  });
}

export function useToolPatchMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (updatedTool: UpdateToolData["body"] & { id: string }) =>
      (await updateTool({ body: updatedTool, path: { id: updatedTool.id } }))
        .data ?? null,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tools"] });
    },
  });
}
