import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import config from "@/lib/config";

/**
 * Query key factory for identity provider-related queries
 */
export const identityProviderKeys = {
  all: ["identity-provider"] as const,
  public: ["identity-provider", "public"] as const,
  details: () => [...identityProviderKeys.all, "details"] as const,
};

/**
 * Get public identity providers (minimal info for login page, no secrets)
 * Use this for unauthenticated contexts like the login page.
 * Automatically disabled when enterprise license is not activated.
 */
export function usePublicIdentityProviders() {
  return useQuery({
    queryKey: identityProviderKeys.public,
    queryFn: async () => {
      const { data } = await archestraApiSdk.getPublicIdentityProviders();
      return data;
    },
    retry: false, // Don't retry on auth pages to avoid repeated 401 errors
    throwOnError: false, // Don't throw errors to prevent crashes
    enabled: config.enterpriseLicenseActivated,
  });
}

/**
 * Get identity providers with full configuration (admin only, requires authentication)
 * Use this for authenticated admin contexts like the identity providers settings page.
 * Automatically disabled when enterprise license is not activated.
 */
export function useIdentityProviders() {
  return useQuery({
    queryKey: identityProviderKeys.all,
    queryFn: async () => {
      const { data } = await archestraApiSdk.getIdentityProviders();
      return data;
    },
    retry: false,
    throwOnError: false,
    enabled: config.enterpriseLicenseActivated,
  });
}

/**
 * Get single identity provider
 */
export function useIdentityProvider(id: string) {
  return useQuery({
    queryKey: [...identityProviderKeys.details(), id],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getIdentityProvider({
        path: { id },
      });
      return data;
    },
    retry: false,
    throwOnError: false,
    enabled: config.enterpriseLicenseActivated,
  });
}

/**
 * Create identity provider
 */
export function useCreateIdentityProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.CreateIdentityProviderData["body"],
    ) => {
      const { data: createdProvider } =
        await archestraApiSdk.createIdentityProvider({
          body: data,
        });
      return createdProvider;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: identityProviderKeys.all });
      toast.success("Identity provider created successfully");
    },
    onError: (error) => {
      toast.error(`Failed to create identity provider: ${error.message}`);
    },
  });
}

/**
 * Update identity provider
 */
export function useUpdateIdentityProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: archestraApiTypes.UpdateIdentityProviderData["body"];
    }) => {
      const { data: updatedProvider } =
        await archestraApiSdk.updateIdentityProvider({
          path: { id },
          body: data,
        });
      return updatedProvider;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: identityProviderKeys.all });
      queryClient.invalidateQueries({
        queryKey: identityProviderKeys.details(),
      });
      toast.success("Identity provider updated successfully");
    },
    onError: (error) => {
      toast.error(`Failed to update identity provider: ${error.message}`);
    },
  });
}

/**
 * Delete identity provider
 */
export function useDeleteIdentityProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await archestraApiSdk.deleteIdentityProvider({
        path: { id },
      });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: identityProviderKeys.all });
      toast.success("Identity provider deleted successfully");
    },
    onError: (error) => {
      toast.error(`Failed to delete identity provider: ${error.message}`);
    },
  });
}
