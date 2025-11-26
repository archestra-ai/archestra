import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { toast } from "sonner";

/**
 * Query key factory for SSO provider-related queries
 */
export const ssoProviderKeys = {
  all: ["ssoProvider"] as const,
  list: () => [...ssoProviderKeys.all, "list"] as const,
  detail: (id: string) => [...ssoProviderKeys.all, "detail", id] as const,
};

/**
 * Fetch all SSO providers for the organization
 */
export function useSsoProviders() {
  return useSuspenseQuery({
    queryKey: ssoProviderKeys.list(),
    queryFn: async () => {
      const { data } = await archestraApiSdk.getSsoProviders();
      return data || [];
    },
  });
}

/**
 * Fetch a single SSO provider by ID
 */
export function useSsoProvider(id: string) {
  return useQuery({
    queryKey: ssoProviderKeys.detail(id),
    queryFn: async () => {
      const { data } = await archestraApiSdk.getSsoProvider({ params: { id } });
      return data;
    },
    enabled: !!id,
  });
}

/**
 * Create SSO provider mutation
 */
export function useCreateSsoProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.CreateSsoProviderData["body"],
    ) => {
      const { data: provider } = await archestraApiSdk.createSsoProvider({
        body: data,
      });

      if (!provider) {
        throw new Error("Failed to create SSO provider");
      }

      return provider;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ssoProviderKeys.list() });
      toast.success("SSO provider created successfully");
    },
    onError: (error) => {
      toast.error("Failed to create SSO provider", {
        description: error.message || "An error occurred",
      });
    },
  });
}

/**
 * Update SSO provider mutation
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
      const { data: provider } = await archestraApiSdk.updateSsoProvider({
        params: { id },
        body: data,
      });

      if (!provider) {
        throw new Error("Failed to update SSO provider");
      }

      return provider;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ssoProviderKeys.list() });
      queryClient.invalidateQueries({
        queryKey: ssoProviderKeys.detail(variables.id),
      });
      toast.success("SSO provider updated successfully");
    },
    onError: (error) => {
      toast.error("Failed to update SSO provider", {
        description: error.message || "An error occurred",
      });
    },
  });
}

/**
 * Delete SSO provider mutation
 */
export function useDeleteSsoProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await archestraApiSdk.deleteSsoProvider({ params: { id } });
      return id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ssoProviderKeys.list() });
      toast.success("SSO provider deleted successfully");
    },
    onError: (error) => {
      toast.error("Failed to delete SSO provider", {
        description: error.message || "An error occurred",
      });
    },
  });
}
