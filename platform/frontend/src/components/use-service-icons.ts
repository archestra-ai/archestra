import { useInfiniteQuery } from "@tanstack/react-query";
import type { ServiceIcon } from "./service-logo-picker.utils";

const PAGE_SIZE = 120;

interface ServiceIconsResponse {
  data: ServiceIcon[];
  total: number;
}

export function useServiceIcons(query: string) {
  const normalizedQuery = query.trim();

  return useInfiniteQuery({
    queryKey: ["service-icons", normalizedQuery],
    queryFn: ({ pageParam, signal }) =>
      fetchServiceIcons({
        query: normalizedQuery,
        offset: pageParam,
        signal,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) => {
      const loadedCount = pages.reduce(
        (count, page) => count + page.data.length,
        0,
      );
      return loadedCount < lastPage.total ? loadedCount : undefined;
    },
    staleTime: 60 * 60 * 1000,
  });
}

async function fetchServiceIcons({
  query,
  offset,
  signal,
}: {
  query: string;
  offset: number;
  signal: AbortSignal;
}): Promise<ServiceIconsResponse> {
  const searchParams = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (query) searchParams.set("q", query);
  if (offset > 0) searchParams.set("offset", String(offset));

  const response = await fetch(`/api/service-icons?${searchParams}`, {
    signal,
  });
  if (!response.ok) {
    throw new Error("Failed to load service icons");
  }
  return response.json() as Promise<ServiceIconsResponse>;
}
