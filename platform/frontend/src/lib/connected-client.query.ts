import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils/api";

const { getConnectedClientLog } = archestraApiSdk;

type ConnectionLogQuery = NonNullable<
  archestraApiTypes.GetConnectedClientLogData["query"]
>;
export type ConnectionLogPage =
  archestraApiTypes.GetConnectedClientLogResponses["200"];
export type ConnectionEvent = ConnectionLogPage["data"][number];
export type ConnectionEventAction = ConnectionEvent["action"];

const connectedClientKeys = {
  all: ["connected-clients"] as const,
  log: (query: ConnectionLogQuery) =>
    [...connectedClientKeys.all, "log", query] as const,
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
