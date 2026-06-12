import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useFeature } from "@/lib/config/config.query";

const { getTeams, getTeamVaultFolder } = archestraApiSdk;

type TeamsResponse = archestraApiTypes.GetTeamsResponses["200"];
export type Team = TeamsResponse["data"][number];
type Teams = Team[];
export type TeamWithVaultPath = Team & { vaultPath?: string | null };
type TeamsQuery = NonNullable<archestraApiTypes.GetTeamsData["query"]>;
type TeamsPaginatedParams = Pick<TeamsQuery, "limit" | "offset" | "name">;

export function useTeams(params?: {
  initialData?: Teams;
  enabled?: boolean;
  /**
   * When true, fetch only the teams the current user is a member of (even for
   * organization-level team managers). Use for resource team-assignment, where
   * membership determines which teams can be assigned.
   */
  mine?: boolean;
}) {
  const mine = params?.mine ?? false;
  return useQuery({
    queryKey: mine ? ["teams", "mine"] : ["teams"],
    queryFn: async () => {
      const { data } = await getTeams({
        query: { limit: 100, offset: 0, ...(mine ? { mine: true } : {}) },
      });
      return data?.data ?? [];
    },
    initialData: params?.initialData as Team[] | undefined,
    enabled: params?.enabled,
  });
}

/** The teams the current user is a member of. */
export function useMyTeams(params?: { enabled?: boolean }) {
  return useTeams({ mine: true, enabled: params?.enabled });
}

/**
 * Teams the current user may assign a team-scoped resource to: a full
 * resource-admin can assign any team, anyone else only teams they belong to.
 * Pass the resource's admin flag (e.g. agent:admin, mcpServerInstallation:admin).
 */
export function useAssignableTeams(params: {
  isResourceAdmin: boolean;
  enabled?: boolean;
}) {
  const enabled = params.enabled ?? true;
  const isAdmin = !!params.isResourceAdmin;
  const allTeams = useTeams({ enabled: enabled && isAdmin });
  const myTeams = useTeams({ mine: true, enabled: enabled && !isAdmin });
  return isAdmin ? allTeams : myTeams;
}

export function useTeamsPaginated(params: TeamsPaginatedParams) {
  return useQuery({
    queryKey: ["teams", "paginated", params],
    queryFn: async () => {
      const { data } = await getTeams({ query: params });
      return (
        data ?? {
          data: [] as Team[],
          pagination: {
            currentPage: 1,
            limit: params.limit,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        }
      );
    },
  });
}

/**
 * Hook to get teams with their vault folder paths
 * Fetches teams first, then fetches vault folders for each team in parallel
 */
export function useTeamsWithVaultFolders() {
  const byosEnabled = useFeature("byosEnabled");
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
      enabled: byosEnabled && !!teams,
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
