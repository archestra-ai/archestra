import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils/api";
import type { GatewayToolRow } from "./gateway-tools";

const { getAgents } = archestraApiSdk;

/**
 * One gateway's tool rows, read when a cell's tooltip opens; the list itself
 * loads only counts. It reads the list endpoint for the one id, so names,
 * filtering and access match the list, and trashed gateways work too. The key
 * sits under `["agents", ...]`, so agent changes refresh it, and both
 * tooltips of a row share it.
 */
export function useGatewayToolRows(params: {
  id: string;
  agentTypes: NonNullable<
    archestraApiTypes.GetAgentsData["query"]
  >["agentTypes"];
  status?: "active" | "deleted";
}) {
  const { id, agentTypes, status } = params;
  return useQuery({
    queryKey: ["agents", "gateway-tool-rows", id, { agentTypes, status }],
    queryFn: async (): Promise<GatewayToolRow[]> => {
      const { data, error } = await getAgents({
        query: { ids: [id], includeTools: true, limit: 1, agentTypes, status },
      });
      throwOnApiError(error, { toastOnError: false });
      return data?.data[0]?.tools ?? [];
    },
    // Lets the row's other tooltip reuse the read; agent changes refresh it.
    staleTime: 5 * 60 * 1000,
  });
}
