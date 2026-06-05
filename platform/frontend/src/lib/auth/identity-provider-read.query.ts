import { archestraApiSdk } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import config from "@/lib/config/config";

export const identityProviderReadKeys = {
  all: ["identity-provider"] as const,
  public: ["identity-provider", "public"] as const,
};

export function usePublicIdentityProviders() {
  return useQuery({
    queryKey: identityProviderReadKeys.public,
    queryFn: async () => {
      const { data } = await archestraApiSdk.getPublicIdentityProviders();
      return data ?? [];
    },
    retry: false,
    throwOnError: false,
    enabled: config.enterpriseFeatures.core,
  });
}

export function useIdentityProviders(params?: { enabled?: boolean }) {
  return useQuery({
    queryKey: identityProviderReadKeys.all,
    queryFn: async () => {
      const { data } = await archestraApiSdk.getIdentityProviders();
      return data ?? [];
    },
    retry: false,
    throwOnError: false,
    enabled: config.enterpriseFeatures.core && (params?.enabled ?? true),
  });
}
