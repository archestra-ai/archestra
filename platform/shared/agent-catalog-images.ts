/** Maintained runtime image names shared by the catalog and background prefetch. */
import AGENT_CATALOG_IMAGE_NAMES from "./agent-catalog-images.json";

export type AgentCatalogId = keyof typeof AGENT_CATALOG_IMAGE_NAMES;

/** Public registry the maintained catalog images are published to. */
export const AGENT_CATALOG_IMAGE_REGISTRY =
  "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public";

/**
 * The catalog tag that matches a platform version. The approved stable
 * release moves :latest. Prerelease and commit builds keep their matching
 * image tag instead of pulling an older stable CLI.
 */
export function getAgentCatalogImageTag(version: string): string {
  return /^\d+\.\d+\.\d+$/.test(version) ? "latest" : version;
}

export function getAgentCatalogImages(params: {
  registry: string;
  tag: string;
}): Record<AgentCatalogId, string> {
  const registry = params.registry.replace(/\/+$/, "");
  return Object.fromEntries(
    Object.entries(AGENT_CATALOG_IMAGE_NAMES).map(([id, name]) => [
      id,
      `${registry}/${name}:${params.tag}`,
    ]),
  ) as Record<AgentCatalogId, string>;
}

/**
 * Which maintained CLI template a saved runtime runs, or null for a custom
 * one. A runtime stores no template id, so this reads the `archestra-<id>`
 * wrapper command each template launches with, the same fingerprint the
 * launch path keys on.
 */
export function resolveAgentCatalogId(runtime: unknown): AgentCatalogId | null {
  if (!runtime || typeof runtime !== "object") return null;
  const { command } = runtime as { command?: unknown };
  const executable = Array.isArray(command) ? command[0] : undefined;
  return typeof executable === "string"
    ? (CATALOG_ID_BY_COMMAND[executable] ?? null)
    : null;
}

const CATALOG_ID_BY_COMMAND: Record<string, AgentCatalogId> =
  Object.fromEntries(
    (Object.keys(AGENT_CATALOG_IMAGE_NAMES) as AgentCatalogId[]).map((id) => [
      `archestra-${id}`,
      id,
    ]),
  );
