import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { useIsAuthenticated } from "@/lib/auth/auth.hook";
import { throwOnApiError } from "@/lib/utils";
import appConfig, { DEFAULT_BACKEND_URL } from "./config";

const { getConfig } = archestraApiSdk;

export type ConfigResponse = archestraApiTypes.GetConfigResponses["200"];
export type FeaturesResponse = ConfigResponse["features"];
export type PublicConfigResponse =
  archestraApiTypes.GetPublicConfigResponses["200"];

export function useConfig() {
  const isAuthenticated = useIsAuthenticated();
  return useQuery({
    queryKey: ["config"],
    queryFn: async () => {
      const { data, error } = await getConfig();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    staleTime: 5 * 60 * 1000,
    enabled: isAuthenticated,
  });
}

export function usePublicConfig() {
  return useQuery({
    queryKey: ["public-config"],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getPublicConfig();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useDisableBasicAuth(): boolean | undefined {
  const { data, isLoading } = usePublicConfig();
  if (isLoading || !data) return undefined;
  return data.disableBasicAuth;
}

export function useDisableInvitations(): boolean | undefined {
  const { data, isLoading } = usePublicConfig();
  if (isLoading || !data) return undefined;
  return data.disableInvitations;
}

/**
 * Effective enterprise-core flag from the public (unauthenticated) config.
 * Use this on pre-login surfaces (sign-in page, SSO picker); authenticated
 * pages should use {@link useEnterpriseFeature}("core") instead.
 */
export function usePublicEnterpriseCoreActive(): boolean | undefined {
  const { data, isLoading } = usePublicConfig();
  if (isLoading || !data) return undefined;
  return data.enterpriseCoreActive;
}

export function useProviderBaseUrls() {
  const { data, ...rest } = useConfig();
  return { data: data?.providerBaseUrls ?? null, ...rest };
}

export function useFeature<K extends keyof FeaturesResponse>(
  flag: K,
): FeaturesResponse[K] | undefined {
  const { data } = useConfig();
  if (!data) return undefined;
  return data.features[flag];
}

type EnterpriseFeatures = ConfigResponse["enterpriseFeatures"];
type EnterpriseFeatureKey = keyof EnterpriseFeatures;

export function useEnterpriseFeature(feature: EnterpriseFeatureKey): boolean {
  const { data, isLoading } = useConfig();
  if (isLoading || !data) return false;
  return data.enterpriseFeatures[feature] ?? false;
}

export type SmallTeamTierState = ConfigResponse["smallTeamTier"];

export function useSmallTeamTier(): SmallTeamTierState | undefined {
  const { data } = useConfig();
  return data?.smallTeamTier;
}

export function usePublicBaseUrl(options?: { ignoreNgrok?: boolean }): string {
  const { data, isLoading } = useConfig();
  if (isLoading || !data) return "";
  if (!options?.ignoreNgrok && data.features.ngrokDomain) {
    const domain = data.features.ngrokDomain.replace(/^https?:\/\//, "");
    return `https://${domain}`;
  }
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return appConfig.api.externalProxyUrls[0] ?? DEFAULT_BACKEND_URL;
}
