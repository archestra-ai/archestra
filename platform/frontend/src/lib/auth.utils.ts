import type { Permissions } from "@shared";

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
