import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

export type ConnectedClient =
  archestraApiTypes.GetConnectedClientsResponses["200"][number];

export const connectedClientKeys = {
  mine: ["connected-clients"] as const,
};

/** The signed-in user's connected coding clients, most recent first. */
export function useConnectedClients() {
  return useQuery({
    queryKey: connectedClientKeys.mine,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getConnectedClients();
      throwOnApiError(error);
      return data ?? [];
    },
  });
}

/**
 * Disconnect one of the signed-in user's clients server-side. Its local
 * config stays until the user runs the cleanup prompt.
 */
export function useDisconnectConnectedClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (clientId: ConnectedClient["clientId"]) => {
      const { data, error } = await archestraApiSdk.disconnectConnectedClient({
        path: { clientId },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Disconnected.");
      queryClient.invalidateQueries({ queryKey: connectedClientKeys.mine });
    },
  });
}
