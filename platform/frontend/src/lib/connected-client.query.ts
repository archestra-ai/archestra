import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils/api";

const { getMemberConnectedClients } = archestraApiSdk;

type MemberConnectionsQuery = NonNullable<
  archestraApiTypes.GetMemberConnectedClientsData["query"]
>;
export type MemberConnectionsPage =
  archestraApiTypes.GetMemberConnectedClientsResponses["200"];
export type MemberConnections = MemberConnectionsPage["data"][number];
export type MemberConnectionStatus = NonNullable<
  MemberConnectionsQuery["status"]
>;

const connectedClientKeys = {
  all: ["connected-clients"] as const,
  members: (query: MemberConnectionsQuery) =>
    [...connectedClientKeys.all, "members", query] as const,
};

/** Every member with the agents they connected, for the admin Logs tab. */
export function useMemberConnections(
  query: Required<Pick<MemberConnectionsQuery, "limit" | "offset">> &
    Pick<MemberConnectionsQuery, "name" | "status">,
) {
  return useQuery({
    queryKey: connectedClientKeys.members(query),
    queryFn: async () => {
      const response = await getMemberConnectedClients({ query });
      throwOnApiError(response.error, { toastOnError: false });
      return response.data ?? null;
    },
  });
}
