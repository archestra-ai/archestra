import {
  archestraApiSdk,
  type archestraApiTypes,
  type ClientFilter,
} from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils/api";

const { getToolsWithAssignments } = archestraApiSdk;

type GetToolsWithAssignmentsQueryParams = NonNullable<
  archestraApiTypes.GetToolsWithAssignmentsData["query"]
>;

// Exported type for tool with assignments data
export type ToolWithAssignmentsData =
  archestraApiTypes.GetToolsWithAssignmentsResponses["200"]["data"][number];

export function useToolsWithAssignments({
  initialData,
  pagination,
  sorting,
  filters,
  enabled = true,
}: {
  initialData?: archestraApiTypes.GetToolsWithAssignmentsResponses["200"];
  pagination?: {
    limit?: number;
    offset?: number;
  };
  sorting?: {
    sortBy?: NonNullable<GetToolsWithAssignmentsQueryParams["sortBy"]>;
    sortDirection?: NonNullable<
      GetToolsWithAssignmentsQueryParams["sortDirection"]
    >;
  };
  filters?: {
    search?: string;
    origin?: string;
    observedByUserId?: string;
    observedByClient?: ClientFilter;
    excludeArchestraTools?: boolean;
    includeKnowledgeSourcesTool?: boolean;
  };
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: [
      "tools-with-assignments",
      {
        limit: pagination?.limit,
        offset: pagination?.offset,
        sortBy: sorting?.sortBy,
        sortDirection: sorting?.sortDirection,
        search: filters?.search,
        origin: filters?.origin,
        observedByUserId: filters?.observedByUserId,
        observedByClient: filters?.observedByClient,
        excludeArchestraTools: filters?.excludeArchestraTools,
        includeKnowledgeSourcesTool: filters?.includeKnowledgeSourcesTool,
      },
    ],
    queryFn: async () => {
      const result = await getToolsWithAssignments({
        query: {
          limit: pagination?.limit,
          offset: pagination?.offset,
          sortBy: sorting?.sortBy,
          sortDirection: sorting?.sortDirection,
          search: filters?.search,
          origin: filters?.origin,
          observedByUserId: filters?.observedByUserId,
          observedByClient: filters?.observedByClient,
          excludeArchestraTools: filters?.excludeArchestraTools,
          includeKnowledgeSourcesTool: filters?.includeKnowledgeSourcesTool,
        },
      });
      throwOnApiError(result.error, { toastOnError: false });
      return (
        result.data ?? {
          data: [],
          pagination: {
            currentPage: 1,
            limit: 20,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        }
      );
    },
    initialData,
    enabled,
  });
}
