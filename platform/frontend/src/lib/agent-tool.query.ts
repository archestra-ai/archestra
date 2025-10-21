import { useSuspenseQuery } from "@tanstack/react-query";
import { getAllAgentTools } from "@/lib/clients/api";

export function useAgentTools() {
  return useSuspenseQuery({
    queryKey: ["agent-tools"],
    queryFn: async () => {
      const result = await getAllAgentTools();
      return result.data ?? [];
    },
  });
}