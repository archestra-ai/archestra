import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { SelectedCategory } from "@/app/mcp-catalog/_parts/CatalogFilters";
import {
  type GetMcpServerCategoriesResponse,
  getMcpServerCategories,
  type SearchMcpServerCatalogData,
  type SearchMcpServerCatalogResponses,
  searchMcpServerCatalog,
} from "./clients/archestra-catalog";

type SearchResponse = SearchMcpServerCatalogResponses[200];
type CategoryType = NonNullable<
  SearchMcpServerCatalogData["query"]
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
      const response = await searchMcpServerCatalog({
        query: {
          q: search?.trim(),
          category: categoryParam,
          limit,
          offset: pageParam,
          sortBy: "quality", // Sort by quality score (highest first)
        },
      });
      if (!response.data) {
        throw new Error("No data returned from Archestra catalog");
      }
      return response.data;
    },
    getNextPageParam: (lastPage) => {
      return lastPage.hasMore ? lastPage.offset + lastPage.limit : undefined;
    },
    initialPageParam: 0,
  });
}

// Fetch available categories
export function useMcpServerCategories() {
  return useQuery({
    queryKey: ["archestra-catalog", "categories"],
    queryFn: async (): Promise<
      GetMcpServerCategoriesResponse["categories"]
    > => {
      const response = await getMcpServerCategories();
      if (!response.data) {
        throw new Error("No categories returned from Archestra catalog");
      }
      return response.data.categories;
    },
  });
}
