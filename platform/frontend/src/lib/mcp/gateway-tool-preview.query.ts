import { archestraApiSdk } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils/api";

export function useGatewayToolPreview(params: {
  agentId: string | undefined;
  client: "claude-code" | "generic";
}) {
  return useQuery({
    queryKey: ["agents", params.agentId, "mcp-tool-preview", params.client],
    enabled: !!params.agentId,
    staleTime: 0,
    queryFn: async () => {
      if (!params.agentId) return undefined;
      const { data, error } = await archestraApiSdk.getAgentMcpToolPreview({
        path: { id: params.agentId },
        query: { client: params.client },
      });
      throwOnApiError(error);
      return data;
    },
  });
}
