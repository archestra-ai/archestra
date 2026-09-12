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

const CATALOG_REGISTRY =
  "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public";
