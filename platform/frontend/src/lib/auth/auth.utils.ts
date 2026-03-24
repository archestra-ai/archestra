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
