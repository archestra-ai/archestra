// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  hasScopedPermission,
  type ResourcePermissionAction,
  type ScopedPermission,
} from "@archestra/shared";
import { ResourcePermissions } from "@/services/resource-permissions";
import { getPermissionsForUserContext } from "./utils";

/**
 * Plugin RBAC helpers. Access to an individual plugin comes from grants in
 * resource_permission_policies; `plugin:create` is the only role action that
 * still decides anything on its own. A plugin's author starts with full access
 * to it, so creating one is enough to read, edit, delete, and install it.
 */

interface PluginPermissionChecker {
  /** True if a grant gives the action on this plugin (or at `*`). */
  allowsScoped: (pluginId: string, action: PluginAction) => boolean;
  /** Holds `plugin:read`, or a read grant on some plugin. */
  canRead: boolean;
  /** Reads every plugin — a read grant at `*` scope. */
  canReadAll: boolean;
  /** The caller's plugin grants, for other checks in the same request to reuse. */
  grants: ScopedPermission[];
}

type PluginAction = Extract<
  ResourcePermissionAction,
  "read" | "use" | "update" | "delete" | "manage-permissions"
>;

/**
 * Fetch the user's plugin permissions once for a request. Resolves via the
 * service-account-aware lookup so token-authenticated service accounts get
 * their role's permissions instead of an empty set.
 */
export async function getPluginPermissionChecker(params: {
  userId: string;
  organizationId: string;
}): Promise<PluginPermissionChecker> {
  const [permissions, grants] = await Promise.all([
    getPermissionsForUserContext(params),
    ResourcePermissions.resolveAll({ ...params, resources: ["plugin"] }),
  ]);
  const plugin = permissions.plugin ?? [];
  return {
    grants,
    allowsScoped: (pluginId, action) =>
      hasScopedPermission({
        grants,
        required: {
          organizationId: params.organizationId,
          resource: "plugin",
          scope: pluginId,
          action,
        },
      }),
    canRead:
      plugin.includes("read") ||
      grants.some(
        (grant) => grant.resource === "plugin" && grant.action === "read",
      ),
    canReadAll: grants.some(
      (grant) =>
        grant.resource === "plugin" &&
        grant.scope === "*" &&
        grant.action === "read",
    ),
  };
}
