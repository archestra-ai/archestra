import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

export type ConnectedClient =
  archestraApiTypes.GetConnectedClientsResponses["200"][number];
export type ConnectedUsersPage =
  archestraApiTypes.GetConnectedUsersResponses["200"];

export const connectedClientKeys = {
  mine: ["connected-clients"] as const,
  users: (params: { limit: number; offset: number }) =>
    ["connected-clients", "users", params] as const,
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
 * Admin view: members who connected a client, with their gateway and LLM
 * proxy use over the last 30 days. Needs member:read and log:read.
 */
export function useConnectedUsers(params: { limit: number; offset: number }) {
  return useQuery({
    queryKey: connectedClientKeys.users(params),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getConnectedUsers({
        query: params,
      });
      throwOnApiError(error);
      return data;
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
