import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

const {
  disconnectConnectedClient,
  getAgentAdoption,
  getAgentAdoptionUsage,
  getConnectedClientLog,
  getConnectedClients,
} = archestraApiSdk;

export type ConnectedClient =
  archestraApiTypes.GetConnectedClientsResponses["200"][number];

type ConnectionLogQuery = NonNullable<
  archestraApiTypes.GetConnectedClientLogData["query"]
>;
export type ConnectionLogPage =
  archestraApiTypes.GetConnectedClientLogResponses["200"];
export type ConnectionEvent = ConnectionLogPage["data"][number];
export type ConnectionEventAction = ConnectionEvent["action"];
export type AgentAdoption = archestraApiTypes.GetAgentAdoptionResponses["200"];
export type AgentAdoptionMember = AgentAdoption["members"][number];
export type AgentAdoptionStatus = AgentAdoptionMember["status"];
/** The span adoption reads; the last 30 days when no start is given. */
export type AdoptionWindow = { startDate?: string; endDate?: string };
export type AgentAdoptionUsage =
  archestraApiTypes.GetAgentAdoptionUsageResponses["200"];

const connectedClientKeys = {
  all: ["connected-clients"] as const,
  mine: () => [...connectedClientKeys.all, "mine"] as const,
  log: (query: ConnectionLogQuery) =>
    [...connectedClientKeys.all, "log", query] as const,
  adoption: (window: AdoptionWindow) =>
    [...connectedClientKeys.all, "adoption", window] as const,
  usage: (window: AdoptionWindow, userId?: string) =>
    [
      ...connectedClientKeys.all,
      "adoption",
      "usage",
      window,
      userId ?? null,
    ] as const,
};

/**
 * The signed-in user's connected agents, most recently connected first, each
 * with when its gateway or LLM proxy traffic was last seen.
 */
export function useConnectedClients() {
  return useQuery({
    queryKey: connectedClientKeys.mine(),
    queryFn: async () => {
      const response = await getConnectedClients();
      throwOnApiError(response.error, { toastOnError: false });
      return response.data ?? [];
    },
  });
}

/**
 * Disconnect one of the signed-in user's agents on the server. Its local
 * config stays until the user runs the cleanup prompt.
 */
export function useDisconnectConnectedClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (clientId: ConnectedClient["clientId"]) => {
      const { data, error } = await disconnectConnectedClient({
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
      queryClient.invalidateQueries({ queryKey: connectedClientKeys.all });
    },
  });
}

/** The organization's agent connect and disconnect events, newest first. */
export function useConnectionLog(query: ConnectionLogQuery) {
  return useQuery({
    queryKey: connectedClientKeys.log(query),
    queryFn: async () => {
      const response = await getConnectedClientLog({ query });
      throwOnApiError(response.error, { toastOnError: false });
      return response.data ?? null;
    },
  });
}

/** Every member with the agents they set up and their agents' last traffic. */
export function useAgentAdoption(window: AdoptionWindow) {
  return useQuery({
    queryKey: connectedClientKeys.adoption(window),
    queryFn: async () => {
      const response = await getAgentAdoption({ query: window });
      throwOnApiError(response.error, { toastOnError: false });
      return response.data ?? null;
    },
  });
}

/** Daily gateway and LLM proxy calls for one member, or everyone. */
export function useAgentAdoptionUsage(window: AdoptionWindow, userId?: string) {
  return useQuery({
    queryKey: connectedClientKeys.usage(window, userId),
    queryFn: async () => {
      const response = await getAgentAdoptionUsage({
        query: { ...window, userId },
      });
      throwOnApiError(response.error, { toastOnError: false });
      return response.data ?? null;
    },
  });
}
