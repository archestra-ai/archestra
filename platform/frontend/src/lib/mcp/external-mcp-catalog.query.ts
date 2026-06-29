import {
  archestraCatalogSdk,
  type archestraCatalogTypes,
} from "@archestra/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { SelectedCategory } from "@/app/mcp/registry/_parts/CatalogFilters";
import { throwOnApiError } from "@/lib/utils";

type SearchResponse =
  archestraCatalogTypes.SearchMcpServerCatalogResponses[200];
type CategoryType = NonNullable<
  archestraCatalogTypes.SearchMcpServerCatalogData["query"]
>["category"];

// Fetch servers with infinite scroll pagination support
export function useMcpRegistryServersInfinite(
  search?: string,
  category?: SelectedCategory,
  limit = 50,
) {
  // Convert category to the correct type for API
  const categoryParam: CategoryType = category === "all" ? undefined : category;

  return useInfiniteQuery({
    queryKey: [
      "archestra-catalog",
      "servers-infinite",
      search,
      categoryParam,
      limit,
    ],
    queryFn: async ({ pageParam = 0 }): Promise<SearchResponse> => {
      const { data, error } = await archestraCatalogSdk.searchMcpServerCatalog({
        query: {
          q: search?.trim(),
          category: categoryParam,
          limit,
          offset: pageParam,
          sortBy: "quality", // Sort by quality score (highest first)
          worksInArchestra: true,
        },
      });
      throwOnApiError(error);
      return (
        data ?? {
          servers: [],
          totalCount: 0,
          limit,
          offset: pageParam,
          hasMore: false,
        }
      );
    },
    getNextPageParam: (lastPage) => {
      return lastPage.hasMore ? lastPage.offset + lastPage.limit : undefined;
    },
    initialPageParam: 0,
  });
}

export function useMcpRegistryServer(serverName: string | null) {
  return useQuery({
    queryKey: ["archestra-catalog", "server-details", serverName],
    queryFn: async (): Promise<
      archestraCatalogTypes.GetMcpServerResponses[200] | null
    > => {
      if (!serverName) {
        return null;
      }
      const { data, error } = await archestraCatalogSdk.getMcpServer({
        path: {
          name: serverName,
        },
      });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
    },
  });
}

export function useMcpServerCategories() {
  return useQuery({
    queryKey: ["archestra-catalog", "categories"],
    queryFn: async (): Promise<
      archestraCatalogTypes.GetMcpServerCategoriesResponse["categories"]
    > => {
      const { data, error } =
        await archestraCatalogSdk.getMcpServerCategories();
      throwOnApiError(error);
      return data?.categories ?? [];
    },
  });
}
