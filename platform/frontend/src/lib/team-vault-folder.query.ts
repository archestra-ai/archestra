import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const {
  getTeamVaultFolder,
  setTeamVaultFolder,
  deleteTeamVaultFolder,
  checkTeamVaultFolderConnectivity,
  listTeamVaultFolderSecrets,
  getTeamVaultSecretKeys,
} = archestraApiSdk;

export type TeamVaultFolder =
  archestraApiTypes.GetTeamVaultFolderResponses["200"];
export type VaultSecretListItem =
  archestraApiTypes.ListTeamVaultFolderSecretsResponses["200"][number];

/**
 * Hook to get a team's Vault folder configuration
 */
export function useTeamVaultFolder(teamId: string | null) {
  return useQuery({
    queryKey: ["team-vault-folder", teamId],
    queryFn: async () => {
      if (!teamId) return null;
      const { data, error } = await getTeamVaultFolder({
        path: { teamId },
      });
      if (error) {
        throw new Error(
          typeof error.error === "string"
            ? error.error
            : error.error?.message || "Failed to fetch team Vault folder",
        );
      }
      return data;
    },
    enabled: !!teamId,
    throwOnError: false, // Handle errors gracefully in the component instead of crashing
  });
}

/**
 * Hook to set or update a team's Vault folder path
 */
export function useSetTeamVaultFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      teamId,
      vaultPath,
    }: {
      teamId: string;
      vaultPath: string;
    }) => {
      const { data, error } = await setTeamVaultFolder({
        path: { teamId },
        body: { vaultPath },
      });
      if (error) {
        throw new Error(
          typeof error.error === "string"
            ? error.error
            : error.error?.message || "Failed to set Vault folder",
        );
      }
      return data;
    },
    onSuccess: (_, variables) => {
      toast.success("Vault folder configured successfully");
      queryClient.invalidateQueries({
        queryKey: ["team-vault-folder", variables.teamId],
      });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to configure Vault folder");
    },
  });
}

/**
 * Hook to delete a team's Vault folder mapping
 */
export function useDeleteTeamVaultFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (teamId: string) => {
      const { data, error } = await deleteTeamVaultFolder({
        path: { teamId },
      });
      if (error) {
        throw new Error(
          typeof error.error === "string"
            ? error.error
            : error.error?.message || "Failed to delete Vault folder",
        );
      }
      return data;
    },
    onSuccess: (_, teamId) => {
      toast.success("Vault folder removed successfully");
      queryClient.invalidateQueries({
        queryKey: ["team-vault-folder", teamId],
      });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to remove Vault folder");
    },
  });
}

/**
 * Hook to check connectivity to a team's Vault folder
 */
export function useCheckTeamVaultFolderConnectivity() {
  return useMutation({
    mutationFn: async ({
      teamId,
      vaultPath,
    }: {
      teamId: string;
      vaultPath?: string;
    }) => {
      const { data, error } = await checkTeamVaultFolderConnectivity({
        path: { teamId },
        body: { vaultPath },
      });
      if (error) {
        throw new Error(
          typeof error.error === "string"
            ? error.error
            : error.error?.message || "Failed to check Vault connectivity",
        );
      }
      return data;
    },
  });
}

/**
 * Hook to list secrets in a team's Vault folder
 */
export function useTeamVaultFolderSecrets(teamId: string | null) {
  return useQuery({
    queryKey: ["team-vault-folder-secrets", teamId],
    queryFn: async () => {
      if (!teamId) return [];
      const { data, error } = await listTeamVaultFolderSecrets({
        path: { teamId },
      });
      if (error) {
        throw new Error(
          typeof error.error === "string"
            ? error.error
            : error.error?.message || "Failed to list Vault secrets",
        );
      }
      return data ?? [];
    },
    enabled: !!teamId,
    throwOnError: false, // Handle errors gracefully in the component instead of crashing
  });
}

/**
 * Hook to get keys of a specific secret in a team's Vault folder
 */
export function useTeamVaultSecretKeys(
  teamId: string | null,
  secretPath: string | null,
) {
  return useQuery({
    queryKey: ["team-vault-secret-keys", teamId, secretPath],
    queryFn: async () => {
      if (!teamId || !secretPath) return { keys: [] };
      const { data, error } = await getTeamVaultSecretKeys({
        path: { teamId },
        body: { secretPath },
      });
      if (error) {
        const errorMessage =
          (error as { error?: { message?: string } })?.error?.message ||
          (typeof error === "object" && "message" in error
            ? (error as { message: string }).message
            : null) ||
          "Failed to get secret keys";
        throw new Error(errorMessage);
      }
      return data ?? { keys: [] };
    },
    enabled: !!teamId && !!secretPath,
    retry: false, // Don't retry on 403/404 errors
    throwOnError: false, // Handle errors gracefully in the component instead of crashing
  });
}
