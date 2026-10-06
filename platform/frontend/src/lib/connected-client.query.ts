import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils/api";

const { getAgentAdoption, getAgentAdoptionUsage, getConnectedClientLog } =
  archestraApiSdk;

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
export type AgentAdoptionUsage =
  archestraApiTypes.GetAgentAdoptionUsageResponses["200"];

const connectedClientKeys = {
  all: ["connected-clients"] as const,
  log: (query: ConnectionLogQuery) =>
    [...connectedClientKeys.all, "log", query] as const,
  adoption: () => [...connectedClientKeys.all, "adoption"] as const,
  usage: (userId?: string) =>
    [...connectedClientKeys.all, "adoption", "usage", userId ?? null] as const,
};

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
export function useAgentAdoption() {
  return useQuery({
    queryKey: connectedClientKeys.adoption(),
    queryFn: async () => {
      const response = await getAgentAdoption();
      throwOnApiError(response.error, { toastOnError: false });
      return response.data ?? null;
    },
  });
}

/** Daily gateway and LLM proxy calls for one member, or everyone. */
export function useAgentAdoptionUsage(userId?: string) {
  return useQuery({
    queryKey: connectedClientKeys.usage(userId),
    queryFn: async () => {
      const response = await getAgentAdoptionUsage({ query: { userId } });
      throwOnApiError(response.error, { toastOnError: false });
      return response.data ?? null;
    },
  });
}
