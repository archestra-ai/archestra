import {
  archestraApiSdk,
  type archestraApiTypes,
  DEFAULT_THEME_ID,
  type OrganizationTheme,
} from "@shared";
import { useQuery } from "@tanstack/react-query";

type PublicAppearance = archestraApiTypes.GetPublicAppearanceResponse;

const DEFAULT_APPEARANCE: PublicAppearance = {
  theme: DEFAULT_THEME_ID as OrganizationTheme,
  customFont: "lato",
  logo: null,
};

/**
 * Query key factory for appearance-related queries
 */
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
export function usePublicAppearance(enabled = true) {
  return useQuery({
    queryKey: appearanceKeys.public(),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getPublicAppearance();

      if (error || !data) {
        // Return undefined on API failure so sync effects don't overwrite localStorage
        // This allows localStorage values to persist during temporary API outages
        return undefined;
      }

      return data;
    },
    enabled,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
    retry: false, // Don't retry on failure, just use defaults
    throwOnError: false,
    placeholderData: DEFAULT_APPEARANCE, // Use default as placeholder while loading
  });
}
