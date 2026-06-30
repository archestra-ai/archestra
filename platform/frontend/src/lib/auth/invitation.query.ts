import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils";

const { checkInvitation } = archestraApiSdk;

export type InvitationCheckResponse =
  archestraApiTypes.CheckInvitationResponses["200"];

export function useInvitationCheck(invitationId: string | null | undefined) {
  return useQuery({
    queryKey: ["invitation", "check", invitationId],
    queryFn: async () => {
      if (!invitationId) return null;

      const response = await checkInvitation({ path: { id: invitationId } });
      throwOnApiError(response.error, { allowNotFound: true });
      return response.data ?? null;
    },
    enabled: !!invitationId,
    staleTime: 5000, // 5 seconds
  });
}
