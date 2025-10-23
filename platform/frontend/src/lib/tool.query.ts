import { useSuspenseQuery } from "@tanstack/react-query";
import { type GetToolsResponses, getTools } from "@/lib/clients/api";
import { client } from "@/lib/clients/api/client.gen";

export function useTools({
  initialData,
}: {
  initialData?: GetToolsResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["tools"],
    queryFn: async () => (await getTools()).data ?? null,
    initialData,
  });
}

export function useUnassignedTools({
  initialData,
}: {
  initialData?: GetToolsResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["tools", "unassigned"],
    queryFn: async () => {
      const response = await client.get<GetToolsResponses["200"]>({
        url: "/api/tools/unassigned",
      });
      return response.data ?? null;
    },
    initialData,
  });
}

/**
 * Hook to detect when tools are identified.
 * The first 2 tools are seed/mock data, so we wait for the 3rd one.
 */
export function useDetectedTools({
  refetchInterval = 3_000,
}: {
  refetchInterval?: number | null;
} = {}) {
  return useSuspenseQuery({
    queryKey: ["tools", "detection"],
    queryFn: async () => {
      const response = await getTools();
      const tools = response.data ?? [];

      // First 2 are seed data, count beyond that
      const detectedCount = Math.max(0, tools.length - 2);
      const totalTools = tools.length;

      return {
        hasDetectedTools: detectedCount > 0,
        detectedCount,
        totalTools,
        tools,
      };
    },
    ...(refetchInterval !== null ? { refetchInterval } : {}),
  });
}
