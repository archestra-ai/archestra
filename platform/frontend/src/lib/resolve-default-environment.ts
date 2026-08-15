import type { EnvironmentDefaultableResource } from "@archestra/shared";

/**
 * Which environment a new resource of this kind should start out in, mirroring
 * the backend's `resolveDefaultEnvironmentForNewResource`: the org's configured
 * default for the kind, or null (the Default environment) when none is
 * configured, when the configured one is gone, or when it is restricted and
 * this user may not deploy there.
 *
 * The restricted fallback is what keeps a create form honest: the environment
 * selector hides restricted environments the user can't deploy to, so
 * pre-selecting one would show a value they cannot pick back.
 */
export function resolveDefaultEnvironmentId(params: {
  environments: { id: string; restricted: boolean }[];
  resourceDefaults: Partial<Record<EnvironmentDefaultableResource, string | null>>;
  resource: EnvironmentDefaultableResource;
  canDeployToRestricted: boolean;
}): string | null {
  const { environments, resourceDefaults, resource, canDeployToRestricted } =
    params;

  const configuredId = resourceDefaults[resource] ?? null;
  if (!configuredId) return null;

  const environment = environments.find(
    (candidate) => candidate.id === configuredId,
  );
  if (!environment) return null;
  if (environment.restricted && !canDeployToRestricted) return null;
  return environment.id;
}
