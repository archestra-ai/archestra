/**
 * Decides which environment name (if any) to surface on a catalog card.
 *
 * - Hidden entirely unless the org has more than the single implicit Default
 *   environment — i.e. at least one real environment exists. With only Default
 *   around, the label carries no information.
 * - Items assigned to a real environment show that environment's name.
 * - Items on the implicit Default environment (null `environmentId`) stay
 *   unlabeled. The registry already treats that placement as the baseline.
 *
 * Returns null when nothing should be rendered.
 */
export function resolveCatalogEnvironmentLabel({
  environmentId,
  environments,
}: {
  environmentId: string | null;
  environments: Array<{ id: string; name: string }>;
  /** Accepted for callers that also render the Environments settings label. */
  defaultEnvironmentName?: string;
}): string | null {
  if (environments.length === 0) return null;
  if (environmentId === null) return null;

  return environments.find((env) => env.id === environmentId)?.name ?? null;
}
