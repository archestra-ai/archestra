import {
  DEFAULT_THEME_ID,
  type OrganizationCustomFont,
  type OrganizationTheme,
} from "@shared";
import { useQuery } from "@tanstack/react-query";

/**
 * Public appearance data returned by the backend
 * This matches the PublicAppearanceSchema from backend/src/types/organization.ts
 */
export interface PublicAppearance {
  theme: OrganizationTheme;
  customFont: OrganizationCustomFont;
  logo: string | null;
}

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
 * Fetch public appearance settings (theme, logo, font) for unauthenticated pages.
 * This endpoint does not require authentication.
 */
async function fetchPublicAppearance(): Promise<PublicAppearance> {
  const response = await fetch("/api/appearance/public");

  if (!response.ok) {
    // Return defaults if fetch fails
    return DEFAULT_APPEARANCE;
  }

  return response.json();
}

/**
 * Hook to fetch public appearance settings.
 * Used on login/auth pages where the user is not yet authenticated.
 * Returns theme, customFont, and logo without requiring authentication.
 */
export function usePublicAppearance(enabled = true) {
  return useQuery({
    queryKey: appearanceKeys.public(),
    queryFn: fetchPublicAppearance,
    enabled,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
    retry: false, // Don't retry on failure, just use defaults
    throwOnError: false,
    placeholderData: DEFAULT_APPEARANCE,
  });
}
