import type { IncomingHttpHeaders } from "node:http";
import type { Action, Permissions, Resource } from "@shared";
import config from "@/config";

export async function hasPermission(
  ...args: [Permissions, IncomingHttpHeaders]
): Promise<{ success: boolean; error: Error | null }> {
  const { hasPermission } = config.enterpriseLicenseActivated
    ? // biome-ignore lint/style/noRestrictedImports: conditional EE import
      await import("./utils.ee")
    : {
        hasPermission: async (
          _permissions: Permissions,
          _requestHeaders: IncomingHttpHeaders,
        ): Promise<{ success: boolean; error: Error | null }> => {
          return {
            success: true, // Always allow - no permission check in non-enterprise version
            error: null,
          };
        },
      };
  return hasPermission.apply(null, args);
}

/**
 * Check if a user has a specific permission.
 * Different form hasPermission, because it doesn't require the request headers, but user and organization IDs.
 * In EE mode: checks the user's role permissions
 * In non-EE mode: returns true (no permission restrictions)
 */
export async function userHasPermission(
  userId: string,
  organizationId: string,
  resource: Resource,
  action: Action,
): Promise<boolean> {
  const { userHasPermission } = config.enterpriseLicenseActivated
    ? // biome-ignore lint/style/noRestrictedImports: conditional EE import
      await import("./utils.ee")
    : {
        userHasPermission: async (
          _userId: string,
          _organizationId: string,
          _resource: Resource,
          _action: Action,
        ): Promise<boolean> => {
          return true; // Always allow - no permission check in non-enterprise version
        },
      };
  return userHasPermission(userId, organizationId, resource, action);
}
