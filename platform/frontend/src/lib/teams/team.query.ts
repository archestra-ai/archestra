import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { useFeature } from "@/lib/config/config.query";
import { handleApiError, toApiError } from "@/lib/utils";

const { createTeam, deleteTeam, getTeams, getTeamVaultFolder } =
  archestraApiSdk;

type TeamsResponse = archestraApiTypes.GetTeamsResponses["200"];
export type Team = TeamsResponse["data"][number];
type Teams = Team[];
export type TeamWithVaultPath = Team & { vaultPath?: string | null };
type TeamsQuery = NonNullable<archestraApiTypes.GetTeamsData["query"]>;
type TeamsPaginatedParams = Pick<TeamsQuery, "limit" | "offset" | "name">;

export function useTeams(params?: { initialData?: Teams; enabled?: boolean }) {
  return useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const { data } = await getTeams({ query: { limit: 100, offset: 0 } });
      return data?.data ?? [];
    },
    initialData: params?.initialData as Team[] | undefined,
    enabled: params?.enabled,
  });
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

export function useCreateTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: archestraApiTypes.CreateTeamData["body"]) => {
      const { data, error } = await createTeam({ body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }

      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Team created successfully");
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
    },
  });
}

export function useDeleteTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await deleteTeam({ path: { id } });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }

      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Team deleted successfully");
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
    },
  });
}
