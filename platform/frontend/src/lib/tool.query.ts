import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  type GetToolsResponses,
  getTools,
  type UpdateToolData,
  updateTool,
} from "shared/api-client";

export function useTools({
  initialData,
}: {
  initialData?: GetToolsResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["tools"],
    queryFn: async () => (await getTools()).data ?? null,
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
