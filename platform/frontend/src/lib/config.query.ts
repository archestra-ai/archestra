import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { useIsAuthenticated } from "@/lib/auth.hook";

const { getConfig } = archestraApiSdk;

export type ConfigResponse = archestraApiTypes.GetConfigResponses["200"];
export type FeaturesResponse = ConfigResponse["features"];

/**
 * Fetch the full config (features + providerBaseUrls).
 * Only fetches when the user is authenticated.
 */
export function useConfig() {
  const isAuthenticated = useIsAuthenticated();
  return useQuery({
    queryKey: ["config"],
    queryFn: async () => (await getConfig()).data ?? null,
    staleTime: 5 * 60 * 1000,
    enabled: isAuthenticated,
  });
}

/**
 * Convenience hook: returns just the features object.
 * Backward-compatible with consumers that only need feature flags.
 */
export function useFeatures() {
  const { data, ...rest } = useConfig();
  return { data: data?.features ?? null, ...rest };
}

/**
 * Returns the provider base URLs from the config endpoint.
 */
export function useProviderBaseUrls() {
  const { data, ...rest } = useConfig();
  return { data: data?.providerBaseUrls ?? null, ...rest };
}
