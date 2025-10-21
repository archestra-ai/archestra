import { useQuery } from "@tanstack/react-query";

export function useGithubStars() {
  return useQuery({
    queryKey: ["github", "stars"],
    queryFn: async () => {
      const response = await fetch(
        "https://api.github.com/repos/archestra-ai/archestra",
      );
      const data = await response.json();
      return data?.stargazers_count ?? null;
    },
  });
}
