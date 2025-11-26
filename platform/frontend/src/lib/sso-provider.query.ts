import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

/**
 * Query key factory for SSO provider-related queries
 */
export const ssoProviderKeys = {
  all: ["sso-provider"] as const,
  details: () => [...ssoProviderKeys.all, "details"] as const,
};

/**
 * Get SSO providers
 */
export function useSsoProviders() {
  return useQuery({
    queryKey: ssoProviderKeys.all,
    queryFn: async () => {
      const { data } = await archestraApiSdk.getSsoProviders();
      return data;
    },
    retry: false, // Don't retry on auth pages to avoid repeated 401 errors
    throwOnError: false, // Don't throw errors to prevent crashes
  });
}

// /**
//  * Update SSO provider
//  */
// export function useUpdateSsoProvider() {
//   const queryClient = useQueryClient();
//   return useMutation({
//     mutationFn: async (
//       data: archestraApiTypes.UpdateSsoProviderData["body"],
//     ) => {
//       const { data: updatedSsoProvider } =
//         await archestraApiSdk.updateSsoProvider({ body: data });

//       if (!updatedSsoProvider) {
//         throw new Error("Failed to update SSO provider");
//       }

//       return updatedSsoProvider;
//     },
//     onSuccess: () => {
//       queryClient.invalidateQueries({ queryKey: ssoProviderKeys.details() });
//       toast.success("SSO provider updated successfully");
//     },
//     onError: (_error) => {
//       toast.error("Failed to update SSO provider");
//     },
//   });
// }
