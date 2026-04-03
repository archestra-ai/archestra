"use client";

import { useQuery } from "@tanstack/react-query";

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

export function useLatestGitHubRelease() {
  return useQuery({
    queryKey: ["github-latest-release"],
    queryFn: fetchLatestRelease,
    staleTime: 60 * 60 * 1000, // 1 hour
    gcTime: 60 * 60 * 1000, // 1 hour cache
    retry: false,
  });
}
