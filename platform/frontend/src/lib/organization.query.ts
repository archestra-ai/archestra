import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { Invitation } from "better-auth/plugins/organization";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { authClient } from "@/lib/clients/auth/auth-client";

/**
 * Query key factory for organization-related queries
 */
export const organizationKeys = {
  all: ["organization"] as const,
  invitations: () => [...organizationKeys.all, "invitations"] as const,
  invitation: (id: string) => [...organizationKeys.invitations(), id] as const,
  activeOrg: () => [...organizationKeys.all, "active"] as const,
  activeMemberRole: () =>
    [...organizationKeys.activeOrg(), "member-role"] as const,
};

/**
 * Fetch invitation details by ID
 */
export function useInvitation(invitationId: string) {
  const session = authClient.useSession();
  return useSuspenseQuery({
    queryKey: organizationKeys.invitation(invitationId),
    queryFn: async () => {
      if (!session) {
        return { data: null, error: null };
      }
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
      return data?.role;
    },
    enabled: !!organizationId,
  });
}

/**
 * Accept invitation mutation
 */
export function useAcceptInvitation() {
  const router = useRouter();
  return useMutation({
    mutationFn: async (invitationId: string) => {
      const response = await authClient.organization.acceptInvitation({
        invitationId,
      });
      return response.data;
    },
    onSuccess: () => {
      router.push("/");
    },
    onError: (error) => {
      toast.error("Error", {
        description: JSON.stringify(error) || "Failed to accept invitation",
      });
    },
  });
}

/**
 * Reject invitation mutation
 */
export function useRejectInvitation() {
  const router = useRouter();
  return useMutation({
    mutationFn: async (invitationId: string) => {
      const response = await authClient.organization.rejectInvitation({
        invitationId,
      });
      return response.data;
    },
    onSuccess: () => {
      router.push("/");
    },
    onError: (error) => {
      toast.error("Error", {
        description: error.message || "Failed to reject invitation",
      });
    },
  });
}

/**
 * List all invitations for an organization
 */
export function useInvitationsList(
  organizationId: string | undefined,
  showAllStatuses = false,
) {
  return useSuspenseQuery({
    queryKey: [
      ...organizationKeys.invitations(),
      organizationId,
      showAllStatuses,
    ],
    queryFn: async () => {
      if (!organizationId) return [];

      const response = await authClient.organization.listInvitations({
        query: { organizationId },
      });

      if (!response.data) return [];

      const now = new Date();
      return response.data
        .filter((inv) => showAllStatuses || inv.status === "pending")
        .map((inv: Invitation) => {
          const expiresAt = inv.expiresAt || null;
          const isExpired = expiresAt ? new Date(expiresAt) < now : false;

          return {
            id: inv.id,
            email: inv.email,
            role: inv.role || "member",
            expiresAt,
            isExpired,
            status: inv.status || "pending",
          };
        })
        .sort((a, b) => {
          // Sort by status first (pending > accepted > rejected)
          const statusOrder: Record<string, number> = {
            pending: 0,
            accepted: 1,
            rejected: 2,
          };
          const statusDiff = statusOrder[a.status] - statusOrder[b.status];
          if (statusDiff !== 0) return statusDiff;

          // Then by expiry
          if (a.isExpired !== b.isExpired) {
            return a.isExpired ? 1 : -1;
          }
          return 0;
        });
    },
  });
}

/**
 * Cancel invitation mutation
 */
export function useCancelInvitation(organizationId: string | undefined) {
  return useMutation({
    mutationFn: async (invitationId: string) => {
      const response = await authClient.organization.cancelInvitation({
        invitationId,
      });
      return response.data;
    },
    onSuccess: () => {
      toast.success("Invitation cancelled");
    },
    onError: (error) => {
      toast.error("Failed to cancel invitation", {
        description: error.message,
      });
    },
  });
}

/**
 * Reinvite mutation (cancel old + create new)
 */
export function useReinvite(organizationId: string | undefined) {
  return useMutation({
    mutationFn: async ({
      email,
      oldInvitationId,
    }: {
      email: string;
      oldInvitationId: string;
    }) => {
      // Cancel old invitation
      await authClient.organization.cancelInvitation({
        invitationId: oldInvitationId,
      });

      // Create new invitation
      const response = await authClient.organization.inviteMember({
        email,
        role: "member",
        organizationId,
      });

      return response.data;
    },
    onSuccess: (_, variables) => {
      toast.success("New invitation created", {
        description: `A fresh invitation link has been generated for ${variables.email}`,
      });
    },
    onError: (error) => {
      toast.error("Failed to reinvite", {
        description: error.message,
      });
    },
  });
}

/**
 * Create invitation mutation
 */
export function useCreateInvitation(organizationId: string | undefined) {
  return useMutation({
    mutationFn: async ({
      email,
      role,
    }: {
      email: string;
      role: "member" | "admin";
    }) => {
      const response = await authClient.organization.inviteMember({
        email,
        role,
        organizationId,
      });

      if (response.error) {
        throw new Error(
          response.error.message || "Failed to generate invitation link",
        );
      }

      return response.data;
    },
    onSuccess: (data) => {
      toast.success("Invitation link generated", {
        description: "Share this link with the person you want to invite",
      });
    },
    onError: (error) => {
      toast.error("Error", {
        description: error.message || "Failed to generate invitation link",
      });
    },
  });
}
