import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQuery } from "@tanstack/react-query";

const { getTools, getToolsWithAssignments } = archestraApiSdk;

type GetToolsWithAssignmentsQueryParams = NonNullable<
  archestraApiTypes.GetToolsWithAssignmentsData["query"]
>;

// Exported type for tool with assignments data
export type ToolWithAssignmentsData =
  archestraApiTypes.GetToolsWithAssignmentsResponses["200"]["data"][number];

/** Non-suspense version for use in dialogs/portals */
export function useTools({
  initialData,
}: {
  initialData?: archestraApiTypes.GetToolsResponses["200"];
}) {
  return useQuery({
    queryKey: ["tools"],
    queryFn: async () => (await getTools()).data ?? null,
    initialData,
  });
}

export function useToolsWithAssignments({
  initialData,
  pagination,
  sorting,
  filters,
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
  };
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
        },
      });
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
  });
}
