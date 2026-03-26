import { type Permissions, type Resource, resourceLabels } from "@shared";

/**
 * Format a Permissions object into a human-readable "Missing permissions: ..." string
 * using resource display labels.
 */
export function formatMissingPermissions(permissions: Permissions): string {
  const parts = Object.entries(permissions).map(([resource, actions]) => {
    const label = resourceLabels[resource as Resource] ?? resource;
    return `${label} (${actions.join(", ")})`;
  });

  return `Missing permissions: ${parts.join(", ")}`;
}

export function hasPermissions(
  userPermissions: Permissions | undefined,
  permissionsToCheck: Permissions,
): boolean {
  if (!permissionsToCheck || Object.keys(permissionsToCheck).length === 0) {
    return true;
  }

  if (!userPermissions) {
    return false;
  }

  for (const [resource, actions] of Object.entries(permissionsToCheck)) {
    const userActions = userPermissions[resource as keyof Permissions];
    if (!userActions) {
      return false;
    }

    for (const action of actions) {
      if (!(userActions as readonly string[]).includes(action)) {
        return false;
      }
    }
  }

  return true;
}
