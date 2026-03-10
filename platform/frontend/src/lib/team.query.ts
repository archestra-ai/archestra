import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQueries, useQuery } from "@tanstack/react-query";
import { DEFAULT_TABLE_LIMIT, handleApiError } from "./utils";

const { getTeams, getTeamVaultFolder } = archestraApiSdk;

type PaginatedTeamsResponse = archestraApiTypes.GetTeamsResponses["200"];
export type Team = PaginatedTeamsResponse["data"][number];
export type TeamWithVaultPath = Team & { vaultPath?: string | null };

/**
 * Fetches all teams (no pagination, large limit).
 * Used by components that need the full list (dropdowns, filters, etc.)
 */
export function useTeams(params?: { initialData?: Team[] }) {
  return useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const { data, error } = await getTeams({
        query: { limit: 1000 },
      });
      if (error) {
        handleApiError(error);
        return [];
      }
      return data?.data ?? [];
    },
    initialData: params?.initialData,
  });
}

/**
 * Paginated teams hook for the teams settings page (DataTable).
 */
export function useTeamsPaginated(params?: {
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDirection?: string;
  search?: string;
}) {
  return useQuery({
    queryKey: ["teams", "paginated", params],
    queryFn: async () => {
      const { data, error } = await getTeams({
        query: {
          limit: params?.limit ?? DEFAULT_TABLE_LIMIT,
          offset: params?.offset ?? 0,
          sortBy: params?.sortBy as "name" | "createdAt" | "memberCount",
          sortDirection: params?.sortDirection as "asc" | "desc",
          search: params?.search,
        },
      });
      if (error) {
        handleApiError(error);
        return {
          data: [],
          pagination: {
            currentPage: 1,
            limit: 20,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        };
      }
      return data;
    },
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
