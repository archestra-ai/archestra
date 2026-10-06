import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils/api";

const { getConnectedClientLog } = archestraApiSdk;

type ConnectionLogQuery = NonNullable<
  archestraApiTypes.GetConnectedClientLogData["query"]
>;
export type ConnectionLogPage =
  archestraApiTypes.GetConnectedClientLogResponses["200"];
export type ConnectionLogEntry = ConnectionLogPage["data"][number];

const connectedClientKeys = {
  all: ["connected-clients"] as const,
  log: (query: ConnectionLogQuery) =>
    [...connectedClientKeys.all, "log", query] as const,
};

/** The organization's agent connections, newest first, for the Logs tab. */
export function useConnectionLog(
  query: Required<Pick<ConnectionLogQuery, "limit" | "offset">> &
    Pick<ConnectionLogQuery, "search" | "clientId">,
) {
  return useQuery({
    queryKey: connectedClientKeys.log(query),
    queryFn: async () => {
      const response = await getConnectedClientLog({ query });
      throwOnApiError(response.error, { toastOnError: false });
      return response.data ?? null;
    },
  });
}
