import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQueries, useQuery } from "@tanstack/react-query";

const { getTeams, getTeamVaultFolder } = archestraApiSdk;

type Teams = archestraApiTypes.GetTeamsResponses["200"];
export type Team = Teams[number];
export type TeamWithVaultPath = Team & { vaultPath?: string | null };

export function useTeams(params?: { initialData?: Teams }) {
  return useQuery({
    queryKey: ["teams"],
    queryFn: async () => (await getTeams()).data ?? [],
    initialData: params?.initialData,
  });
}

/**
 * Hook to get teams with their vault folder paths
 * Fetches teams first, then fetches vault folders for each team in parallel
 */
export function useTeamsWithVaultFolders() {
  const { data: teams, isLoading: isLoadingTeams } = useTeams();

  const vaultFolderQueries = useQueries({
    queries: (teams || []).map((team) => ({
      queryKey: ["team-vault-folder", team.id],
      queryFn: async () => {
        const { data } = await getTeamVaultFolder({
          path: { teamId: team.id },
        });
        return { teamId: team.id, vaultPath: data?.vaultPath ?? null };
      },
      enabled: !!teams,
    })),
  });

  const isLoadingVaultFolders = vaultFolderQueries.some((q) => q.isLoading);
  const isLoading = isLoadingTeams || isLoadingVaultFolders;

  // Combine teams with their vault paths
  const teamsWithVaultPaths: TeamWithVaultPath[] = (teams || []).map((team) => {
    const vaultQuery = vaultFolderQueries.find(
      (q) => q.data?.teamId === team.id,
    );
    return {
      ...team,
      vaultPath: vaultQuery?.data?.vaultPath ?? null,
    };
  });

  return {
    data: teamsWithVaultPaths,
    isLoading,
  };
}
