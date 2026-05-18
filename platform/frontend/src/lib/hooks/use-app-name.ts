import { DEFAULT_APP_NAME } from "@shared";
import { useTheme } from "next-themes";
import { useAppearanceSettings } from "@/lib/organization.query";

export const DEFAULT_APP_LOGO = "/logo-icon.svg";

/**
 * Returns the configured app name, preferring authenticated organization data
 * and falling back to public appearance settings on unauthenticated pages.
 */
export function useAppName(): string {
  const { data: appearance } = useAppearanceSettings();
  return appearance?.appName ?? DEFAULT_APP_NAME;
}

/**
 * Returns the configured app icon logo with a stable frontend fallback.
 * Picks the dark-mode variant when active and configured, otherwise falls back
 * to the light variant.
 */
export function useAppIconLogo(): string {
  const { data: appearance } = useAppearanceSettings();
  const { resolvedTheme } = useTheme();
  const dark = appearance?.iconLogoDark;
  const light = appearance?.iconLogo;
  if (resolvedTheme === "dark" && dark) return dark;
  return light ?? DEFAULT_APP_LOGO;
}
