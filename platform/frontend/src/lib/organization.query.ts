import {
  type AnyRoleName,
  archestraApiSdk,
  type archestraApiTypes,
} from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Invitation } from "better-auth/plugins/organization";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { authClient } from "@/lib/clients/auth/auth-client";
import { handleApiError } from "./utils";

export const appearanceKeys = {
  all: ["appearance"] as const,
  public: () => [...appearanceKeys.all, "public"] as const,
};

/**
 * Hook to fetch public appearance settings.
 * Used on login/auth pages where the user is not yet authenticated.
 * Returns theme, customFont, and logo without requiring authentication.
 * On API failure, returns undefined (treated as not loaded) to preserve localStorage values.
 */
export function useAppearanceSettings(enabled = true) {
  return useQuery({
    queryKey: appearanceKeys.public(),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getAppearanceSettings();

      if (error || !data) {
        return undefined;
      }

      return data;
    },
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
    throwOnError: false,
  });
}

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
  onboardingStatus: () =>
    [...organizationKeys.all, "onboarding-status"] as const,
  memberSignupStatus: () =>
    [...organizationKeys.all, "member-signup-status"] as const,
};

/**
 * Fetch invitation details by ID
 */
export function useInvitation(invitationId: string) {
  const session = authClient.useSession();
  return useQuery({
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
  return useQuery({
    queryKey: [...organizationKeys.invitations(), organizationId],
    queryFn: async () => {
      if (!organizationId) return [];

      const response = await authClient.organization.listInvitations({
        query: { organizationId },
      });

      if (!response.data) return [];

      const now = new Date();
      type InvitationListItem = {
        id: string;
        email: string;
        role: Invitation["role"];
        expiresAt: Invitation["expiresAt"] | null;
        isExpired: boolean;
        status: Invitation["status"];
      };
      return response.data
        .filter((inv: Invitation) => inv.status === "pending")
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
        .sort((a: InvitationListItem, b: InvitationListItem) => {
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
        toast.error(
          response.error.message || "Failed to generate invitation link",
        );
        return null;
      }

      return response.data;
    },
    onSuccess: () => {
      toast.success("Invitation link generated", {
        description: "Share this link with the person you want to invite",
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
 * Check if organization onboarding is complete
 * Only polls when enabled
 */
export function useOrganizationOnboardingStatus(enabled: boolean) {
  return useQuery({
    queryKey: organizationKeys.onboardingStatus(),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOnboardingStatus();

      if (error) {
        handleApiError(error);
        return {
          hasProfilesConfigured: false,
          hasToolsConfigured: false,
          isComplete: false,
        };
      }

      return (
        data ?? {
          hasProfilesConfigured: false,
          hasToolsConfigured: false,
          isComplete: false,
        }
      );
    },
    refetchInterval: enabled ? 3000 : false, // Poll every 3 seconds when dialog is open
    enabled, // Only run query when enabled
  });
}

/**
 * Update appearance settings
 */
export function useUpdateAppearanceSettings(
  onSuccessMessage: string,
  onErrorMessage: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.UpdateAppearanceSettingsData["body"],
    ) => {
      const { data: updatedOrganization, error } =
        await archestraApiSdk.updateAppearanceSettings({ body: data });

      if (error) {
        toast.error(onErrorMessage);
        return null;
      }

      return updatedOrganization;
    },
    onSuccess: (updatedOrganization) => {
      if (!updatedOrganization) return;
      queryClient.setQueryData(organizationKeys.details(), updatedOrganization);
      queryClient.setQueryData(appearanceKeys.public(), {
        theme: updatedOrganization.theme,
        customFont: updatedOrganization.customFont,
        logo: updatedOrganization.logo,
        logoDark: updatedOrganization.logoDark,
        favicon: updatedOrganization.favicon,
        iconLogo: updatedOrganization.iconLogo,
        appName: updatedOrganization.appName,
        ogDescription: updatedOrganization.ogDescription,
        footerText: updatedOrganization.footerText,
        chatLinks: updatedOrganization.chatLinks,
        chatErrorSupportMessage: updatedOrganization.chatErrorSupportMessage,
        slimChatErrorUi: updatedOrganization.slimChatErrorUi,
        animateChatPlaceholders: updatedOrganization.animateChatPlaceholders,
      });
      toast.success(onSuccessMessage);
    },
  });
}

/**
 * Update security settings (global tool policy, chat file uploads)
 */
export function useUpdateSecuritySettings(
  onSuccessMessage: string,
  onErrorMessage: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.UpdateSecuritySettingsData["body"],
    ) => {
      const { data: updatedOrganization, error } =
        await archestraApiSdk.updateSecuritySettings({ body: data });

      if (error) {
        toast.error(onErrorMessage);
        return null;
      }

      return updatedOrganization;
    },
    onSuccess: (updatedOrganization) => {
      if (!updatedOrganization) return;
      queryClient.setQueryData(organizationKeys.details(), updatedOrganization);
      queryClient.invalidateQueries({ queryKey: ["config"] });
      toast.success(onSuccessMessage);
    },
  });
}

/**
 * Update LLM settings (TOON compression, compression scope, limit cleanup interval)
 */
export function useUpdateLlmSettings(
  onSuccessMessage: string,
  onErrorMessage: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.UpdateLlmSettingsData["body"],
    ) => {
      const { data: updatedOrganization, error } =
        await archestraApiSdk.updateLlmSettings({ body: data });

      if (error) {
        toast.error(onErrorMessage);
        return null;
      }

      return updatedOrganization;
    },
    onSuccess: (updatedOrganization) => {
      if (!updatedOrganization) return;
      queryClient.setQueryData(organizationKeys.details(), updatedOrganization);
      toast.success(onSuccessMessage);
    },
  });
}

/**
 * Update agent settings (default model, default agent)
 */
export function useUpdateAgentSettings(
  onSuccessMessage: string,
  onErrorMessage: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.UpdateAgentSettingsData["body"],
    ) => {
      const { data: updatedOrganization, error } =
        await archestraApiSdk.updateAgentSettings({ body: data });

      if (error) {
        toast.error(onErrorMessage);
        return null;
      }

      return updatedOrganization;
    },
    onSuccess: (updatedOrganization) => {
      if (!updatedOrganization) return;
      queryClient.setQueryData(organizationKeys.details(), updatedOrganization);
      toast.success(onSuccessMessage);
    },
  });
}

/**
 * Update MCP settings (OAuth access token lifetime)
 */
export function useUpdateMcpSettings(
  onSuccessMessage: string,
  onErrorMessage: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.UpdateMcpSettingsData["body"],
    ) => {
      const { data: updatedOrganization, error } =
        await archestraApiSdk.updateMcpSettings({ body: data });

      if (error) {
        toast.error(onErrorMessage);
        return null;
      }

      return updatedOrganization;
    },
    onSuccess: (updatedOrganization) => {
      if (!updatedOrganization) return;
      queryClient.setQueryData(organizationKeys.details(), updatedOrganization);
      toast.success(onSuccessMessage);
    },
  });
}

/**
 * Update knowledge settings (embedding model)
 */
export function useUpdateKnowledgeSettings(
  onSuccessMessage: string,
  onErrorMessage: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.UpdateKnowledgeSettingsData["body"],
    ) => {
      const { data: updatedOrganization, error } =
        await archestraApiSdk.updateKnowledgeSettings({ body: data });

      if (error) {
        toast.error(onErrorMessage);
        return null;
      }

      return updatedOrganization;
    },
    onSuccess: (updatedOrganization) => {
      if (!updatedOrganization) return;
      queryClient.setQueryData(organizationKeys.details(), updatedOrganization);
      toast.success(onSuccessMessage);
    },
  });
}

/**
 * Drop embedding configuration (deletes all KB documents, resets connector checkpoints)
 */
export function useDropEmbeddingConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data: updatedOrganization, error } =
        await archestraApiSdk.dropEmbeddingConfig();

      if (error) {
        handleApiError(error);
        return null;
      }

      return updatedOrganization;
    },
    onSuccess: (updatedOrganization) => {
      if (!updatedOrganization) return;
      queryClient.setQueryData(organizationKeys.details(), updatedOrganization);
      toast.success("Embedding configuration dropped");
    },
  });
}

/**
 * Test embedding connection by embedding a sample text
 */
export function useTestEmbeddingConnection() {
  return useMutation({
    mutationFn: async (
      params: NonNullable<
        archestraApiTypes.TestEmbeddingConnectionData["body"]
      >,
    ) => {
      const { data, error } = await archestraApiSdk.testEmbeddingConnection({
        body: params,
      });

      if (error) {
        handleApiError(error);
        return { success: false, error: "Request failed" };
      }

      return data ?? { success: false, error: "No response" };
    },
    onSuccess: (result) => {
      if (!result) return;
      if (result.success) {
        toast.success("Connection test successful");
      } else {
        toast.error("Connection test failed", {
          description: result.error,
        });
      }
    },
  });
}

/**
 * Complete onboarding
 */
export function useCompleteOnboarding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data: updatedOrganization, error } =
        await archestraApiSdk.completeOnboarding({
          body: { onboardingComplete: true },
        });

      if (error) {
        toast.error("Failed to complete onboarding");
        return null;
      }

      return updatedOrganization;
    },
    onSuccess: (updatedOrganization) => {
      if (!updatedOrganization) return;
      queryClient.setQueryData(organizationKeys.details(), updatedOrganization);
      toast.success("Onboarding complete");
    },
  });
}

/**
 * Get all members of the organization (for admin filtering)
 */
export function useOrganizationMembers(enabled = true) {
  return useQuery({
    queryKey: [...organizationKeys.all, "members"],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOrganizationMembers();
      if (error) {
        handleApiError(error);
        return [];
      }
      return data ?? [];
    },
    enabled,
  });
}

export type PendingSignupMember = {
  userId: string;
  name: string | null;
  email: string;
  image: string | null;
  role: string;
  provider: string | null;
  invitationId: string | null;
};

/**
 * Get member signup status — returns members that haven't completed signup
 */
export function useMemberSignupStatus() {
  return useQuery({
    queryKey: organizationKeys.memberSignupStatus(),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getMemberSignupStatus();
      if (error) {
        return { pendingSignupMembers: [] as PendingSignupMember[] };
      }
      return data ?? { pendingSignupMembers: [] as PendingSignupMember[] };
    },
  });
}

/**
 * Delete a pending signup member (auto-provisioned, hasn't completed signup)
 */
export function useDeletePendingSignupMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      const { data, error } = await archestraApiSdk.deletePendingSignupMember({
        path: { userId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({
        queryKey: organizationKeys.memberSignupStatus(),
      });
      toast.success("Pending member removed");
    },
  });
}
