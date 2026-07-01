import { archestraApiSdk } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import {
  useEnterpriseFeature,
  usePublicEnterpriseCoreActive,
} from "@/lib/config/config.query";
import { throwOnApiError } from "@/lib/utils";

export const identityProviderReadKeys = {
  all: ["identity-provider"] as const,
  public: ["identity-provider", "public"] as const,
};

export function usePublicIdentityProviders() {
  // Pre-auth surface (login page), so check the public config flag.
  const enterpriseCoreActive = usePublicEnterpriseCoreActive();
  return useQuery({
    queryKey: identityProviderReadKeys.public,
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.getPublicIdentityProviders();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    retry: false,
    throwOnError: false,
    enabled: enterpriseCoreActive === true,
  });
}

export function useIdentityProviders(params?: { enabled?: boolean }) {
  const enterpriseCoreActive = useEnterpriseFeature("core");
  return useQuery({
    queryKey: identityProviderReadKeys.all,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getIdentityProviders();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    retry: false,
    throwOnError: false,
    enabled: enterpriseCoreActive && (params?.enabled ?? true),
  });
}
