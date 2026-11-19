import { DEFAULT_APP_NAME } from "@archestra/shared";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { useAppearanceSettings } from "@/lib/organization.query";

export const DEFAULT_APP_LOGO = "/logo-icon.svg";
const DEFAULT_APP_LOGO_DARK = "/logo-icon-dark.svg";

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
  // The server cannot know the theme, and React keeps the server's `src` when
  // the hydration render picks a different one. So the hydration render uses
  // the light variant too, and the next render switches to the real theme.
  const hydrating = useSyncExternalStore(
    subscribeToNothing,
    () => false,
    () => true,
  );
  const isDark = !hydrating && resolvedTheme === "dark";
  const dark = appearance?.iconLogoDark;
  const light = appearance?.iconLogo;
  if (isDark && dark) return dark;
  if (light) return light;
  return isDark ? DEFAULT_APP_LOGO_DARK : DEFAULT_APP_LOGO;
}

// ===

// The store never changes: `useSyncExternalStore` serves only to tell the
// hydration render (server snapshot) from later renders (client snapshot).
function subscribeToNothing() {
  return () => {};
}
