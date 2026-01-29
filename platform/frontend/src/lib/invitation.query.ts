import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

export type InvitationCheckResponse = {
  invitation: {
    id: string;
    email: string;
    organizationId: string;
    status: "pending" | "accepted" | "canceled";
    expiresAt: string | null;
  };
  userExists: boolean;
};

export function useInvitationCheck(invitationId: string | null | undefined) {
  return useQuery({
    queryKey: ["invitation", "check", invitationId],
    queryFn: async () => {
      if (!invitationId) return null;

      const response = await fetch(`/api/invitation/${invitationId}/check`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const error = await response.json();
        toast.error(error.message || "Failed to check invitation");
        return null;
      }

      return (await response.json()) as InvitationCheckResponse;
    },
    enabled: !!invitationId,
    staleTime: 5000, // 5 seconds
  });
}
