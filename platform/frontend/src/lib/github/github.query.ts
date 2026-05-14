import { useQuery } from "@tanstack/react-query";
import { useDeferredEnabled } from "@/lib/hooks/use-deferred-enabled";

/**
 * Fetches GitHub stars for optional community chrome.
 *
 * Callers can disable or defer this because it is noncritical external data and
 * should not compete with authenticated shell API calls during initial load.
 */
export function useGithubStars(params?: {
  enabled?: boolean;
  deferMs?: number;
}) {
  const enabled = useDeferredEnabled(
    params?.enabled ?? true,
    params?.deferMs ?? 0,
  );

  return useQuery({
    queryKey: ["github", "stars"],
    queryFn: async () => {
      try {
        const response = await fetch(
          "https://api.github.com/repos/archestra-ai/archestra",
          {
            next: { revalidate: 3600 }, // Cache for 1 hour
          },
        );

        if (!response.ok) {
          console.warn(`GitHub API returned status: ${response.status}`);
          return null;
        }

        const data = await response.json();
        const count = data?.stargazers_count ?? null;
        return count !== null ? formatStarCount(count) : null;
      } catch (error) {
        console.error("Failed to fetch GitHub stars:", error);
        return null;
      }
    },
    retry: false, // Don't retry on failure
    staleTime: 60 * 60 * 1000, // 1 hour
    gcTime: 24 * 60 * 60 * 1000, // 24 hours (formerly cacheTime)
    enabled,
  });
}

export function formatStarCount(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  const thousands = count / 1000;
  return thousands % 1 === 0
    ? `${thousands}k`
    : `${parseFloat(thousands.toFixed(1))}k`;
}
