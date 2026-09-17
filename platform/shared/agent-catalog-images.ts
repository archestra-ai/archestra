/** Maintained runtime image names shared by the catalog and background prefetch. */
import AGENT_CATALOG_IMAGE_NAMES from "./agent-catalog-images.json";

export type AgentCatalogId = keyof typeof AGENT_CATALOG_IMAGE_NAMES;

export function getDefaultAgentRuntimeImage(version: string): string {
  return `${CATALOG_REGISTRY}/${AGENT_CATALOG_IMAGE_NAMES.archestra}:${version}`;
}

export function getAgentCatalogImages(
  baseImage: string,
): Record<AgentCatalogId, string> {
  const suffix = new RegExp(
    `(^|/)${AGENT_CATALOG_IMAGE_NAMES.archestra}(?=:[^/]+$|$)`,
  );
  return Object.fromEntries(
    Object.entries(AGENT_CATALOG_IMAGE_NAMES).map(([id, name]) => [
      id,
      suffix.test(baseImage)
        ? baseImage.replace(suffix, `$1${name}`)
        : id === "archestra"
          ? baseImage
          : `${CATALOG_REGISTRY}/${name}:latest`,
    ]),
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
