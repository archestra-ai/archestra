/**
 * Convert Permissions object to array of permission strings
 */
export function permissionsToStrings(
  permissions: Record<string, string[]>,
): string[] {
  const result: string[] = [];
  for (const [resource, actions] of Object.entries(permissions)) {
    for (const action of actions) {
      result.push(`"${resource}:${action}"`);
    }
  }
  return result;
}
