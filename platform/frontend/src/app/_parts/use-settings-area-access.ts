import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import { useMemo } from "react";
import { usePermissionMap, useScopedCapabilities } from "@/lib/auth/auth.query";
import { useRuntimeCredentials } from "@/lib/runtime-credentials.query";
import {
  canSeeSettingsArea,
  needsOrganizationCredentials,
  SETTINGS_MANAGE_PERMISSIONS,
} from "./settings-navigation";

/**
 * The page permission map the navigation surfaces gate on, plus `/settings`
 * for the Settings area as a whole ({@link canSeeSettingsArea}). `/settings`
 * itself has no page permission: it forwards to the first permitted tab.
 * Null until permissions load, and until the credential list loads for a
 * reader whose only way into Settings may be a grant on one credential.
 */
export function useNavPermissionMap(): Record<string, boolean> | null {
  const pageMap = usePermissionMap(requiredPagePermissionsMap);
  const manageMap = usePermissionMap(SETTINGS_MANAGE_PERMISSIONS);
  const { data: capabilities = NO_CAPABILITIES } = useScopedCapabilities();
  const permissionMap = useMemo(
    () => (pageMap && manageMap ? { ...pageMap, ...manageMap } : null),
    [pageMap, manageMap],
  );
  const needsCredentials =
    permissionMap !== null &&
    needsOrganizationCredentials({ permissionMap, capabilities });
  const credentials = useRuntimeCredentials(needsCredentials);
  const organizationCredentialIds = useMemo(
    () =>
      new Set(
        (credentials.data ?? [])
          .filter((credential) => credential.allowOrganization)
          .map((credential) => credential.id),
      ),
    [credentials.data],
  );
  if (!pageMap || !permissionMap) return null;
  if (needsCredentials && credentials.isPending) return null;
  return {
    ...pageMap,
    "/settings": canSeeSettingsArea({
      permissionMap,
      capabilities,
      organizationCredentialIds,
    }),
  };
}

/** Whether the reader may see the Settings area; null until known. */
export function useSettingsAreaAccess(): boolean | null {
  return useNavPermissionMap()?.["/settings"] ?? null;
}

const NO_CAPABILITIES: readonly never[] = [];
