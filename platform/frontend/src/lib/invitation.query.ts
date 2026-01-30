import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { handleApiError } from "./utils";

const { checkInvitation } = archestraApiSdk;

export type InvitationCheckResponse =
  archestraApiTypes.CheckInvitationResponses["200"];

export function useInvitationCheck(invitationId: string | null | undefined) {
  return useQuery({
    queryKey: ["invitation", "check", invitationId],
    queryFn: async () => {
      if (!invitationId) return null;

      const response = await checkInvitation({ path: { id: invitationId } });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data ?? null;
    },
    enabled: !!invitationId,
    staleTime: 5000, // 5 seconds
  });
}
