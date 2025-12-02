import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import config from "@/lib/config";

/**
 * Query key factory for SSO provider-related queries
 */
export const ssoProviderKeys = {
  all: ["sso-provider"] as const,
  public: ["sso-provider", "public"] as const,
  details: () => [...ssoProviderKeys.all, "details"] as const,
};

/**
 * Get public SSO providers (minimal info for login page, no secrets)
 * Use this for unauthenticated contexts like the login page.
 * Automatically disabled when enterprise license is not activated.
 */
export function usePublicSsoProviders() {
  return useQuery({
    queryKey: ssoProviderKeys.public,
    queryFn: async () => {
      const { data } = await archestraApiSdk.getPublicSsoProviders();
      return data;
    },
    retry: false, // Don't retry on auth pages to avoid repeated 401 errors
    throwOnError: false, // Don't throw errors to prevent crashes
    enabled: config.enterpriseLicenseActivated,
  });
}

/**
 * Get SSO providers with full configuration (admin only, requires authentication)
 * Use this for authenticated admin contexts like the SSO settings page.
 * Automatically disabled when enterprise license is not activated.
 */
export function useSsoProviders() {
  return useQuery({
    queryKey: ssoProviderKeys.all,
    queryFn: async () => {
      const { data } = await archestraApiSdk.getSsoProviders();
      return data;
    },
    retry: false,
    throwOnError: false,
    enabled: config.enterpriseLicenseActivated,
  });
}

/**
 * Get single SSO provider
 */
export function useSsoProvider(id: string) {
  return useQuery({
    queryKey: [...ssoProviderKeys.details(), id],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getSsoProvider({ path: { id } });
      return data;
    },
    retry: false,
    throwOnError: false,
    enabled: config.enterpriseLicenseActivated,
  });
}

/**
 * Create SSO provider
 */
export function useCreateSsoProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.CreateSsoProviderData["body"],
    ) => {
      const { data: createdProvider } = await archestraApiSdk.createSsoProvider(
        {
          body: data,
        },
      );
      return createdProvider;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ssoProviderKeys.all });
      toast.success("SSO provider created successfully");
    },
    onError: (error) => {
      toast.error(`Failed to create SSO provider: ${error.message}`);
    },
  });
}

/**
 * Update SSO provider
 */
export function useUpdateSsoProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: archestraApiTypes.UpdateSsoProviderData["body"];
    }) => {
      const { data: updatedProvider } = await archestraApiSdk.updateSsoProvider(
        {
          path: { id },
          body: data,
        },
      );
      return updatedProvider;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ssoProviderKeys.all });
      queryClient.invalidateQueries({ queryKey: ssoProviderKeys.details() });
      toast.success("SSO provider updated successfully");
    },
    onError: (error) => {
      toast.error(`Failed to update SSO provider: ${error.message}`);
    },
  });
}

/**
 * Delete SSO provider
 */
export function useDeleteSsoProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await archestraApiSdk.deleteSsoProvider({
        path: { id },
      });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ssoProviderKeys.all });
      toast.success("SSO provider deleted successfully");
    },
    onError: (error) => {
      toast.error(`Failed to delete SSO provider: ${error.message}`);
    },
  });
}
