import type { Permissions } from "@shared";
import { authClient } from "@/lib/clients/auth/auth-client";

export const hasPermission = async (permissions: Permissions) => {
  try {
    const { data } = await authClient.organization.hasPermission({
      permissions,
    });
    return data?.success ?? false;
  } catch (_error) {
    return false;
  }
};

/**
 * Convert Permissions object to array of permission strings
 */
export function permissionsToStrings(permissions: Permissions): string[] {
  const result: string[] = [];
  for (const [resource, actions] of Object.entries(permissions)) {
    for (const action of actions) {
      result.push(`"${resource}:${action}"`);
    }
  }
  return result;
}
