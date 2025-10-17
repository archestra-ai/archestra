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
} from "@/lib/clients/api";

export function useTools({
  initialData,
}: {
  initialData?: GetToolsResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["tools"],
    queryFn: async () => (await getTools()).data ?? null,
    initialData,
    // Removed refetchInterval to prevent pagination resets
  });
}

export function useToolPatchMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      updatedTool: UpdateToolData["body"] & { id: string },
    ) => {
      const result =
        (await updateTool({ body: updatedTool, path: { id: updatedTool.id } }))
          .data ?? null;
      return result;
    },
    onSuccess: (data, variables) => {
      // Update the cache directly without invalidating
      queryClient.setQueryData<GetToolsResponses["200"]>(["tools"], (old) => {
        if (!old || !data) return old;

        // Find and update the tool with the response data
        const toolIndex = old.findIndex((tool) => tool.id === variables.id);
        if (toolIndex === -1) {
          return old;
        }

        // Create a new array with the updated tool from the server response
        // Preserve the agent relationship since update response doesn't include it
        const existingTool = old[toolIndex];
        const newTools = [...old];
        newTools[toolIndex] = {
          ...existingTool,
          ...data,
          agent: existingTool.agent, // Always preserve the agent from existing tool
        };
        return newTools;
      });
    },
  });
}
