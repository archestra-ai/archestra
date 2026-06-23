import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { handleApiError } from "@/lib/utils";

const {
  createConnectionSetup,
  createConnectionVirtualKey,
  getConnectionSetupStatus,
} = archestraApiSdk;

export type CreateConnectionSetupBody =
  archestraApiTypes.CreateConnectionSetupData["body"];
export type CreateConnectionSetupResult =
  archestraApiTypes.CreateConnectionSetupResponses["200"];
type CreateConnectionVirtualKeyBody =
  archestraApiTypes.CreateConnectionVirtualKeyData["body"];

export function useCreateConnectionSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateConnectionSetupBody) => {
      const { data, error } = await createConnectionSetup({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      // the setup may have provisioned a personal virtual key and, on script
      // fetch, will create a skill share link — keep those lists fresh.
      queryClient.invalidateQueries({ queryKey: ["virtual-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["skill-share-links"] });
    },
  });
}

/**
 * Provisions (or reuses) the caller's personal connection virtual key for a
 * provider and returns its value once — backs the manual /connection flow's
 * virtual-key option. Same auto-provisioning the one-command setup performs.
 */
export function useCreateConnectionVirtualKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateConnectionVirtualKeyBody) => {
      const { data, error } = await createConnectionVirtualKey({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["virtual-api-keys"] });
    },
  });
}

/**
 * Polls whether a generated setup command has been run yet. The script GET
 * consumes the setup token server-side, so once `consumed` flips true the
 * /connection page can confirm the client is wired up. Polling stops as soon
 * as the setup is consumed (no point re-asking a one-time command).
 */
export function useConnectionSetupStatus(id: string | null) {
  return useQuery({
    queryKey: ["connection-setup-status", id],
    enabled: !!id,
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await getConnectionSetupStatus({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    refetchInterval: (query) => (query.state.data?.consumed ? false : 2500),
  });
}
