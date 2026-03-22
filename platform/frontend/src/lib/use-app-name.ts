import { DEFAULT_APP_NAME } from "@shared";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";

/**
 * Returns the configured app name, preferring authenticated organization data
 * and falling back to public appearance settings on unauthenticated pages.
 */
export function useAppName(): string {
  const { data: organization } = useOrganization();
  const { data: appearance } = useAppearanceSettings();
  return organization?.appName ?? appearance?.appName ?? DEFAULT_APP_NAME;
}
