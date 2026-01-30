import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

/**
 * Invalidates all queries related to tool assignments.
 * Use this after batch operations where individual mutations skip invalidation.
 */
export function invalidateToolAssignmentQueries(
  queryClient: QueryClient,
  affectedAgentIds?: Set<string> | string,
) {
  // Handle both Set<string> and single string for convenience
  const agentIds =
    typeof affectedAgentIds === "string"
      ? [affectedAgentIds]
      : affectedAgentIds
        ? [...affectedAgentIds]
        : [];

  // Invalidate agent-specific queries
  for (const agentId of agentIds) {
    queryClient.invalidateQueries({
      queryKey: ["agents", agentId, "tools"],
    });
    queryClient.invalidateQueries({
      queryKey: ["chat", "agents", agentId, "mcp-tools"],
    });
  }

  // Invalidate global queries
  queryClient.invalidateQueries({ queryKey: ["tools"], exact: true });
  queryClient.invalidateQueries({ queryKey: ["tools", "unassigned"] });
  queryClient.invalidateQueries({ queryKey: ["tools-with-assignments"] });
  queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
  queryClient.invalidateQueries({ queryKey: ["agents"] });
  queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
  queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
  queryClient.invalidateQueries({ queryKey: ["chat", "agents"] });
}

/**
 * Hook that returns a memoized callback for invalidating tool assignment queries.
 * Useful in components that need to manually invalidate after batch operations.
 */
export function useInvalidateToolAssignmentQueries() {
  const queryClient = useQueryClient();

  return useCallback(
    (affectedAgentIds?: Set<string> | string) => {
      invalidateToolAssignmentQueries(queryClient, affectedAgentIds);
    },
    [queryClient],
  );
}
