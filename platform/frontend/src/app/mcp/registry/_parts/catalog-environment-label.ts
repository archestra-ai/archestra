// Fallback name `useDefaultEnvironment()` returns when the org hasn't given the
// implicit Default environment a custom name. Mirrors the check in
// environments-section.tsx, where the "Default" badge is also keyed off it.
export const DEFAULT_ENVIRONMENT_NAME = "Default";

/**
 * Decides which environment name (if any) to surface on a catalog card.
 *
 * - Hidden entirely unless the org has more than the single implicit Default
 *   environment — i.e. at least one real environment exists. With only Default
 *   around, the label carries no information.
 * - Items assigned to a real environment show that environment's name.
 * - Items on the Default environment (null `environmentId`) only show a label
 *   when Default has been renamed; the bare "Default" is noise.
 *
 * Returns null when nothing should be rendered.
 */
export function resolveCatalogEnvironmentLabel({
  environmentId,
  environments,
  defaultEnvironmentName,
}: {
  environmentId: string | null;
  environments: Array<{ id: string; name: string }>;
  defaultEnvironmentName: string;
}): string | null {
  if (environments.length === 0) return null;

  if (environmentId === null) {
    return defaultEnvironmentName === DEFAULT_ENVIRONMENT_NAME
      ? null
      : defaultEnvironmentName;
  }

  return environments.find((env) => env.id === environmentId)?.name ?? null;
}
