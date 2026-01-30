import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQuery } from "@tanstack/react-query";

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
        const msg =
          typeof response.error.error === "string"
            ? response.error.error
            : response.error.error?.message || "Failed to check invitation";
        throw new Error(msg);
      }
      return response.data ?? null;
    },
    enabled: !!invitationId,
    staleTime: 5000, // 5 seconds
  });
}
