// === Public API ===

/** Where the Kubernetes backend runs one Agent Runtime workspace. */
export interface KubernetesRuntimePlacement {
  /**
   * The environment whose own cluster holds the workspace, or null for the
   * platform's own cluster.
   */
  clusterEnvironmentId: string | null;
  namespace: string;
}

/**
 * The Kubernetes backend's `runtimeScope`: the stored, frozen record of where
 * a run's workspace lives. A bare namespace is the platform's own cluster,
 * which is what every scope was before environments could have a cluster of
 * their own. `<environmentId>/<namespace>` is that environment's cluster.
 *
 * The cluster of an environment never changes, so the environment id names
 * the same cluster for as long as the workspace can exist.
 */
export function serializeKubernetesRuntimeScope(
  placement: KubernetesRuntimePlacement,
): string {
  return placement.clusterEnvironmentId === null
    ? placement.namespace
    : `${placement.clusterEnvironmentId}/${placement.namespace}`;
}

/** Reads a stored scope back. Throws on anything `serialize` cannot have written. */
export function parseKubernetesRuntimeScope(
  runtimeScope: string,
): KubernetesRuntimePlacement {
  const separator = runtimeScope.indexOf("/");
  const clusterEnvironmentId =
    separator === -1 ? null : runtimeScope.slice(0, separator);
  const namespace = runtimeScope.slice(separator + 1);
  if (
    !NAMESPACE_PATTERN.test(namespace) ||
    (clusterEnvironmentId !== null && !UUID_PATTERN.test(clusterEnvironmentId))
  ) {
    throw new Error(
      `Not a Kubernetes Agent Runtime scope: ${JSON.stringify(runtimeScope)}`,
    );
  }
  return { clusterEnvironmentId, namespace };
}

/** The namespace of a stored scope, for the many places that need only that. */
export function kubernetesRuntimeNamespace(runtimeScope: string): string {
  return parseKubernetesRuntimeScope(runtimeScope).namespace;
}

// === Internal helpers ===

const NAMESPACE_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
