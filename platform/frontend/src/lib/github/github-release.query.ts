"use client";

import { useQuery } from "@tanstack/react-query";
import { useDeferredEnabled } from "@/lib/hooks/use-deferred-enabled";

interface GitHubRelease {
  tag_name: string;
  html_url: string;
}

async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  try {
    const response = await fetch(
      "https://api.github.com/repos/archestra-ai/archestra/releases/latest",
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
        },
      },
    );

    if (!response.ok) {
      console.error("Failed to fetch latest release:", response.statusText);
      return null;
    }

    const data = await response.json();
    return {
      tag_name: data.tag_name,
      html_url: data.html_url,
    };
  } catch (error) {
    console.error("Error fetching latest release:", error);
    return null;
  }
}

/**
 * Fetches latest release metadata for the footer upgrade hint.
 *
 * Callers can disable or defer this because it is noncritical external data and
 * should not compete with authenticated shell API calls during initial load.
 */
export function useLatestGitHubRelease(params?: {
  enabled?: boolean;
  deferMs?: number;
}) {
  const enabled = useDeferredEnabled(
    params?.enabled ?? true,
    params?.deferMs ?? 0,
  );

  return useQuery({
    queryKey: ["github-latest-release"],
    queryFn: fetchLatestRelease,
    staleTime: 60 * 60 * 1000, // 1 hour
    gcTime: 60 * 60 * 1000, // 1 hour cache
    retry: false,
    enabled,
  });
}
