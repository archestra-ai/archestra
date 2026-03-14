import { useOrganization } from "@/lib/organization.query";

const DEFAULT_APP_NAME = "Archestra";

/**
 * Returns the configured app name (organization.appName),
 * falling back to "Archestra" if not set.
 */
export function useAppName(): string {
  const { data: organization } = useOrganization();
  return (
    ((organization as Record<string, unknown>)?.appName as string) ??
    DEFAULT_APP_NAME
  );
}
