import {
  type AnyRoleName,
  archestraApiSdk,
  type archestraApiTypes,
} from "@shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
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
  details: () => [...organizationKeys.all, "details"] as const,
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
        return undefined;
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
      // Extract the error message from the error object
      const errorMessage =
        error?.message ||
        (error as { error?: { message: string } })?.error?.message ||
        "Failed to accept invitation";

      toast.error("Error", {
        description: errorMessage,
      });
    },
  });
}

/**
 * List all pending invitations for an organization
 */
export function useInvitationsList(organizationId: string | undefined) {
  return useSuspenseQuery({
    queryKey: [...organizationKeys.invitations(), organizationId],
    queryFn: async () => {
      if (!organizationId) return [];

      const response = await authClient.organization.listInvitations({
        query: { organizationId },
      });

      if (!response.data) return [];

      const now = new Date();
      return response.data
        .filter((inv) => inv.status === "pending")
        .map((inv: Invitation) => {
          const expiresAt = inv.expiresAt || null;
          const isExpired = expiresAt ? new Date(expiresAt) < now : false;

          return {
            id: inv.id,
            email: inv.email,
            role: inv.role,
            expiresAt,
            isExpired,
            status: inv.status,
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
 * Delete invitation mutation
 */
export function useCancelInvitation() {
  return useMutation({
    mutationFn: async (invitationId: string) => {
      const response = await authClient.organization.cancelInvitation({
        invitationId,
      });
      return response.data;
    },
    onSuccess: () => {
      toast.success("Invitation deleted");
    },
    onError: (error) => {
      toast.error("Failed to delete invitation", {
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
      role: AnyRoleName;
    }) => {
      const response = await authClient.organization.inviteMember({
        email,
        /**
         * TODO: it looks like better-auth authClient has strict typing here..
         * and apparently, according to their docs, it can only be "owner", "admin", or "member".
         * https://www.better-auth.com/docs/plugins/organization#send-invitation
         */
        role: role as NonNullable<
          Parameters<typeof authClient.organization.inviteMember>[0]
        >["role"],
        organizationId,
      });

      if (response.error) {
        throw new Error(
          response.error.message || "Failed to generate invitation link",
        );
      }

      return response.data;
    },
    onSuccess: () => {
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

/**
 * Get organization
 */
export function useOrganization(enabled = true) {
  const session = authClient.useSession();

  return useQuery({
    queryKey: organizationKeys.details(),
    queryFn: async () => {
      const { data } = await archestraApiSdk.getOrganization();
      return data;
    },
    // Only fetch when user is authenticated to prevent 403 errors during initial auth check
    enabled: enabled && !!session.data?.user,
    retry: false, // Don't retry on auth pages to avoid repeated 401 errors
    throwOnError: false, // Don't throw errors to prevent crashes
  });
}

/**
 * Update organization
 */
export function useUpdateOrganization(
  onSuccessMessage: string,
  onErrorMessage: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.UpdateOrganizationData["body"],
    ) => {
      const { data: updatedOrganization } =
        await archestraApiSdk.updateOrganization({ body: data });

      if (!updatedOrganization) {
        throw new Error(onErrorMessage);
      }

      return updatedOrganization;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: organizationKeys.details() });
      toast.success(onSuccessMessage);
    },
    onError: (_error) => {
      toast.error(onErrorMessage);
    },
  });
}
