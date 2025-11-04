import type { OrganizationAppearance } from "@shared";
import { archestraApiSdk } from "@shared";
import {
  deleteOrganizationLogo,
  getOrganizationAppearance,
  updateOrganizationAppearance,
  uploadOrganizationLogo,
} from "@shared/hey-api/clients/api/sdk.gen";
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
  appearance: () => [...organizationKeys.all, "appearance"] as const,
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
      toast.error("Error", {
        description: JSON.stringify(error) || "Failed to accept invitation",
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
 * Get organization details including cleanup interval
 */
export function useOrganizationDetails() {
  return useQuery({
    queryKey: organizationKeys.details(),
    queryFn: async () => {
      const response = await archestraApiSdk.getOrganization();
      return response.data;
    },
  });
}

/**
 * Fetch organization appearance settings
 */
export function useOrganizationAppearance() {
  const session = authClient.useSession();

  return useQuery({
    queryKey: organizationKeys.appearance(),
    queryFn: async () => {
      const response = await getOrganizationAppearance();
      return response.data;
    },
    enabled: !!session.data?.user,
  });
}

/**
 * Update organization cleanup interval mutation
 */
export function useUpdateOrganizationCleanupInterval() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      limitCleanupInterval: "1h" | "12h" | "24h" | "1w" | "1m" | null,
    ) => {
      // Use fetch directly to handle null values properly
      const response = await fetch("/api/organization/cleanup-interval", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limitCleanupInterval }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(
          error.error?.message || "Failed to update cleanup interval",
        );
      }

      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: organizationKeys.details() });
      toast.success("Cleanup interval updated successfully");
    },
    onError: (error) => {
      toast.error("Failed to update cleanup interval", {
        description: error.message,
      });
    },
  });
}

/**
 * Update organization appearance settings
 */
export function useUpdateOrganizationAppearance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: Partial<OrganizationAppearance>) => {
      const response = await updateOrganizationAppearance({
        body: data,
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: organizationKeys.appearance(),
      });
      toast.success("Appearance settings updated");
    },
    onError: (error) => {
      toast.error("Failed to update appearance settings", {
        description: error.message,
      });
    },
  });
}

/**
 * Upload organization logo
 */
export function useUploadOrganizationLogo() {
  return useMutation({
    mutationFn: async (logo: string) => {
      const response = await uploadOrganizationLogo({
        body: { logo },
      });
      return response.data;
    },
    onSuccess: () => {
      toast.success("Logo uploaded successfully");
    },
    onError: (error) => {
      toast.error("Failed to upload logo", {
        description: error.message,
      });
    },
  });
}

/**
 * Delete organization logo
 */
export function useDeleteOrganizationLogo() {
  return useMutation({
    mutationFn: async () => {
      const response = await deleteOrganizationLogo();
      return response.data;
    },
    onSuccess: () => {
      toast.success("Logo removed");
    },
    onError: (error) => {
      toast.error("Failed to remove logo", {
        description: error.message,
      });
    },
  });
}
