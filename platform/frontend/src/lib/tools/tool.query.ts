import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils";

const { getTool, getTools, getToolsWithAssignments } = archestraApiSdk;

/**
 * Fetch a single tool's policy-editor fields by id, scoped to what the caller
 * can access. Unlike the assignment-based listing this resolves All-mode tools
 * that have no agent_tools row. `enabled` gates the request.
 */
export function useTool(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["tool", id],
    queryFn: async () => {
      const { data, error } = await getTool({ path: { id: id as string } });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    enabled: enabled && !!id,
  });
}

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
    queryFn: async () => {
      const { data, error } = await getTools();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
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
    excludeArchestraTools?: boolean;
    includeKnowledgeSourcesTool?: boolean;
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
  });
}
