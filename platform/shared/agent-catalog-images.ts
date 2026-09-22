/** Maintained runtime image names shared by the catalog and background prefetch. */
import AGENT_CATALOG_IMAGE_NAMES from "./agent-catalog-images.json";

export type AgentCatalogId = keyof typeof AGENT_CATALOG_IMAGE_NAMES;

export function getDefaultAgentRuntimeImage(version: string): string {
  return `${CATALOG_REGISTRY}/${AGENT_CATALOG_IMAGE_NAMES.archestra}:${version}`;
}

export function getAgentCatalogImages(
  baseImage: string,
): Record<AgentCatalogId, string> {
  const maintainedBasePrefix = `${CATALOG_REGISTRY}/${AGENT_CATALOG_IMAGE_NAMES.archestra}:`;
  const maintainedBaseTag = baseImage.startsWith(maintainedBasePrefix)
    ? baseImage.slice(maintainedBasePrefix.length)
    : null;
  // The approved stable release moves :latest. Prerelease and commit builds
  // must keep their matching image tag instead of pulling an older stable CLI.
  const useStableAlias =
    maintainedBaseTag === "latest" ||
    (maintainedBaseTag !== null && /^\d+\.\d+\.\d+$/.test(maintainedBaseTag));
  const suffix = new RegExp(
    `(^|/)${AGENT_CATALOG_IMAGE_NAMES.archestra}(?=:[^/]+$|$)`,
  );
  return Object.fromEntries(
    Object.entries(AGENT_CATALOG_IMAGE_NAMES).map(([id, name]) => {
      if (id === "archestra") return [id, baseImage];
      if (useStableAlias) return [id, `${CATALOG_REGISTRY}/${name}:latest`];
      if (suffix.test(baseImage))
        return [id, baseImage.replace(suffix, `$1${name}`)];
      return [id, `${CATALOG_REGISTRY}/${name}:latest`];
    }),
  ) as Record<AgentCatalogId, string>;
}

/**
 * Which maintained CLI template a saved runtime runs, or null for a custom
 * one. A runtime stores no template id, so this reads the `archestra-<id>`
 * wrapper command each template launches with, the same fingerprint the
 * launch path keys on.
 */
export function resolveAgentCatalogId(
  runtime: unknown,
): Exclude<AgentCatalogId, "archestra"> | null {
  if (!runtime || typeof runtime !== "object") return null;
  const { command } = runtime as { command?: unknown };
  const executable = Array.isArray(command) ? command[0] : undefined;
  return typeof executable === "string"
    ? (CATALOG_ID_BY_COMMAND[executable] ?? null)
    : null;
}

const CATALOG_REGISTRY =
  "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public";

const CATALOG_ID_BY_COMMAND: Record<
  string,
  Exclude<AgentCatalogId, "archestra">
> = Object.fromEntries(
  (Object.keys(AGENT_CATALOG_IMAGE_NAMES) as AgentCatalogId[])
    .filter((id) => id !== "archestra")
    .map((id) => [`archestra-${id}`, id]),
);
