import {
  archestraApiClient,
  archestraApiSdk,
  type archestraApiTypes,
} from "@archestra/shared";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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
  disconnectReference: () =>
    [...connectedClientKeys.all, "disconnect-reference"] as const,
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

/** A reference lives ten minutes; one on screen is replaced well before. */
const DISCONNECT_REFERENCE_REFRESH_MS = 4 * 60 * 1000;

/**
 * The reference that goes into the cleanup prompt while its dialog is open.
 * Guardrails leave the conversation that presents it unchecked, so the
 * cleanup can remove the gateway without depending on it. Null until it
 * loads and when it cannot be issued: the prompt then works without one,
 * under Guardrails.
 */
export function useDisconnectReference() {
  return useQuery({
    queryKey: connectedClientKeys.disconnectReference(),
    // A dialog opened again gets a reference with its whole lifetime left.
    gcTime: 0,
    staleTime: 0,
    refetchInterval: DISCONNECT_REFERENCE_REFRESH_MS,
    retry: false,
    queryFn: async () => {
      // The endpoint is not in the API reference yet, so the generated
      // client has no function for it.
      const response = await archestraApiClient.get<{
        200: { reference: string; expiresAt: string };
      }>({ url: "/api/connected-clients/disconnect-reference" });
      return response.data?.reference ?? null;
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
    // A new page or a minute tick keeps the rows on screen until the
    // answer lands, so the table never blanks and loses its scroll.
    placeholderData: keepPreviousData,
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
