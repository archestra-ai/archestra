import {
  type Permissions,
  type Resource,
  resourceLabels,
} from "@archestra/shared";

/**
 * Format a Permissions object into a human-readable "Missing permissions: ..." string
 * using resource display labels.
 */
export function formatMissingPermissions(permissions: Permissions): string {
  return `Missing permissions: ${describeResources(permissions).join(SEPARATOR)}`;
}

/**
 * The one wording for "you may not do this". A tooltip alone leaves keyboard
 * and screen reader users with a control that is refused for no stated reason,
 * so every refusal renders this string as text as well.
 *
 * It names the permissions the action requires rather than the subset the user
 * happens to be missing: the sentence describes the gate, and the required set
 * is what an admin needs to hear to grant it.
 */
export function formatPermissionConstraint(permissions: Permissions): string {
  const resources = describeResources(permissions);
  const noun = resources.length > 1 ? "permissions" : "permission";

  return `Available to roles with the ${resources.join(SEPARATOR)} ${noun}`;
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

/** One "Label (action, action)" entry per resource, in declaration order. */
function describeResources(permissions: Permissions): string[] {
  return Object.entries(permissions).map(([resource, actions]) => {
    const label = resourceLabels[resource as Resource] ?? resource;
    return `${label} (${actions.join(SEPARATOR)})`;
  });
}

/** Both lists a permission sentence contains read as one, so they separate alike. */
const SEPARATOR = ", ";
