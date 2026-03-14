import { DEFAULT_APP_NAME } from "@shared";
import { useOrganization } from "@/lib/organization.query";

/**
 * Returns the configured app name (organization.appName),
 * falling back to DEFAULT_APP_NAME if not set.
 */
export function useAppName(): string {
  const { data: organization } = useOrganization();
  return organization?.appName ?? DEFAULT_APP_NAME;
}
