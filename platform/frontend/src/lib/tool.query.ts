import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQuery } from "@tanstack/react-query";

const { getTools } = archestraApiSdk;

type GetToolsQuery = NonNullable<archestraApiTypes.GetToolsData["query"]>;

export function useTools({
  initialData,
  pagination,
  sorting,
  filters,
}: {
  initialData?: archestraApiTypes.GetToolsResponses["200"];
  pagination?: {
    limit?: number;
    offset?: number;
  };
  sorting?: {
    sortBy?: NonNullable<GetToolsQuery["sortBy"]>;
    sortDirection?: NonNullable<GetToolsQuery["sortDirection"]>;
  };
  filters?: {
    search?: string;
    agentId?: string;
    origin?: NonNullable<GetToolsQuery["origin"]>;
    mcpServerOwnerId?: string;
    excludeArchestraTools?: boolean;
  };
}) {
  return useQuery({
    queryKey: [
      "tools",
      {
        limit: pagination?.limit,
        offset: pagination?.offset,
        sortBy: sorting?.sortBy,
        sortDirection: sorting?.sortDirection,
        search: filters?.search,
        agentId: filters?.agentId,
        origin: filters?.origin,
        mcpServerOwnerId: filters?.mcpServerOwnerId,
        excludeArchestraTools: filters?.excludeArchestraTools,
      },
    ],
    queryFn: async () => {
      const result = await getTools({
        query: {
          limit: pagination?.limit,
          offset: pagination?.offset,
          sortBy: sorting?.sortBy,
          sortDirection: sorting?.sortDirection,
          search: filters?.search,
          agentId: filters?.agentId,
          origin: filters?.origin,
          mcpServerOwnerId: filters?.mcpServerOwnerId,
          excludeArchestraTools: filters?.excludeArchestraTools,
        },
      });

      return (
        result.data ?? {
          data: [],
          pagination: {
            currentPage: 1,
            limit: pagination?.limit ?? 20,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        }
      );
    },
    initialData,
  });
}
