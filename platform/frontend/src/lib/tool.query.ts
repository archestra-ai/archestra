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
    mutationFn: async (updatedTool: UpdateToolData["body"] & { id: string }) => {
      const result = (await updateTool({ body: updatedTool, path: { id: updatedTool.id } }))
        .data ?? null;
      return result;
    },
    onSuccess: (data, variables) => {
      // Update the cache directly without invalidating
      queryClient.setQueryData<GetToolsResponses["200"]>(["tools"], (old) => {
        if (!old) return old;

        // Only create a new array if we actually need to update something
        const toolIndex = old.findIndex((tool) => tool.id === variables.id);
        if (toolIndex === -1) {
          return old;
        }

        // Check if the tool actually changed
        const existingTool = old[toolIndex];
        const hasChanges = Object.keys(variables).some(
          (key) =>
            key !== "id" &&
            existingTool[key as keyof typeof existingTool] !==
              variables[key as keyof typeof variables],
        );

        // If no changes, return the same reference
        if (!hasChanges) {
          return old;
        }

        // Create a new array only if there are changes
        const newTools = [...old];
        newTools[toolIndex] = { ...existingTool, ...variables };
        return newTools;
      });
    }
  });
}
