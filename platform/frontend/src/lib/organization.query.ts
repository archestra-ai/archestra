import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { authClient } from "@/lib/clients/auth/auth-client";

/**
 * Query key factory for organization-related queries
 */
export const organizationKeys = {
  all: ["organization"] as const,
  invitations: () => [...organizationKeys.all, "invitations"] as const,
  invitation: (id: string) =>
    [...organizationKeys.invitations(), id] as const,
  activeOrg: () => [...organizationKeys.all, "active"] as const,
  activeMemberRole: () =>
    [...organizationKeys.activeOrg(), "member-role"] as const,
};

/**
 * Fetch invitation details by ID
 */
export function useInvitation(invitationId: string) {
  return useSuspenseQuery({
    queryKey: organizationKeys.invitation(invitationId),
    queryFn: async () => {
      const response = await authClient.organization.getInvitation({
        query: { id: invitationId },
      });
      return response.data;
    },
  });
}

/**
 * Use active organization from authClient hook
 * Note: This uses the authClient hook directly as it's already optimized
 */
export function useActiveOrganization() {
  return authClient.useActiveOrganization();
}

/**
 * Fetch active member role
 */
export function useActiveMemberRole(organizationId?: string) {
  return useQuery({
    queryKey: organizationKeys.activeMemberRole(),
    queryFn: async () => {
      const { data } = await authClient.organization.getActiveMemberRole();
      const role =
        data && typeof data === "object" && "role" in data
          ? (data as any).role
          : (data as any);
      return role as string | null;
    },
    enabled: !!organizationId,
  });
}

/**
 * Accept invitation mutation
 */
export function useAcceptInvitation() {
  return useMutation({
    mutationFn: async (invitationId: string) => {
      const response = await authClient.organization.acceptInvitation({
        invitationId,
      });
      return response.data;
    },
  });
}

/**
 * Reject invitation mutation
 */
export function useRejectInvitation() {
  return useMutation({
    mutationFn: async (invitationId: string) => {
      const response = await authClient.organization.rejectInvitation({
        invitationId,
      });
      return response.data;
    },
  });
}

/**
 * Process invitation after sign-in/sign-up (auto-accept)
 */
export function useProcessInvitation() {
  const acceptMutation = useAcceptInvitation();
  
  return {
    ...acceptMutation,
    processInvitation: acceptMutation.mutateAsync,
  };
}
