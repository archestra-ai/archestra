import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import { useMemo } from "react";
import { usePermissionMap, useScopedCapabilities } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useServerRulesAccess } from "@/lib/openappa-github-sync.query";
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
  const serverRules = useServerRulesAccess();
  const agentRuntimeEnabled = useFeature("agentRuntime") === true;
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
    // Personal Claude Code subscription management is self-service when Agent
    // Runtime is enabled, so Model Providers stays reachable without key-read.
    "/llm/model-providers":
      !!pageMap["/llm/model-providers"] || agentRuntimeEnabled,
    // A reader of some MCP server's rules opens the Policy page for them.
    "/openappa/policy":
      !!pageMap["/openappa/policy"] || serverRules.scoped === true,
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
