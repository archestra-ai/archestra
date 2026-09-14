/** Maintained runtime image names shared by the catalog and background prefetch. */
import AGENT_CATALOG_IMAGE_NAMES from "./agent-catalog-images.json";

export type AgentCatalogId = keyof typeof AGENT_CATALOG_IMAGE_NAMES;

export function getDefaultAgentRuntimeImage(version: string): string {
  return `${CATALOG_REGISTRY}/${AGENT_CATALOG_IMAGE_NAMES.archestra}:${version}`;
}

export function getAgentCatalogImages(
  baseImage: string,
): Record<AgentCatalogId, string> {
  return Object.fromEntries(
    Object.entries(AGENT_CATALOG_IMAGE_NAMES).map(([id, name]) => [
      id,
      ARCHESTRA_IMAGE_SUFFIX.test(baseImage)
        ? baseImage.replace(ARCHESTRA_IMAGE_SUFFIX, `$1${name}`)
        : id === "archestra"
          ? baseImage
          : `${CATALOG_REGISTRY}/${name}:latest`,
    ]),
  ) as Record<AgentCatalogId, string>;
}

/**
 * Which catalog template a saved runtime came from, or null for a custom
 * image. A runtime records no template id, only what the template filled
 * in, so this reads the same fingerprint the launch path already keys on:
 * every maintained CLI template runs its `archestra-<template>` wrapper as
 * the command, and the platform's own loop runs its image with no command.
 *
 * It is a fingerprint, not a record: editing a template agent's command
 * makes it a custom runtime again, and a custom image that runs a wrapper
 * command is that wrapper's template. Both match what actually launches.
 */
export function resolveAgentCatalogId(runtime: unknown): AgentCatalogId | null {
  if (!runtime || typeof runtime !== "object") return null;
  const { image, command } = runtime as { image?: unknown; command?: unknown };
  if (Array.isArray(command) && command.length > 0) {
    const executable = command[0];
    return typeof executable === "string"
      ? (CATALOG_ID_BY_COMMAND[executable] ?? null)
      : null;
  }
  return typeof image === "string" && ARCHESTRA_IMAGE_SUFFIX.test(image)
    ? "archestra"
    : null;
}

const CATALOG_REGISTRY =
  "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public";

/** The platform image's name, wherever it is hosted and whatever its tag. */
const ARCHESTRA_IMAGE_SUFFIX = new RegExp(
  `(^|/)${AGENT_CATALOG_IMAGE_NAMES.archestra}(?=:[^/]+$|$)`,
);

const CATALOG_ID_BY_COMMAND: Record<string, AgentCatalogId> =
  Object.fromEntries(
    (Object.keys(AGENT_CATALOG_IMAGE_NAMES) as AgentCatalogId[])
      .filter((id) => id !== "archestra")
      .map((id) => [`archestra-${id}`, id]),
  );
