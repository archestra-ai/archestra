import type { InternalMcpCatalog } from "@/types";

/**
 * Pure name constructors for the K8s objects owned by an MCP server install.
 *
 * These live outside `K8sDeployment` because callers that never hydrate a
 * deployment need them too — the runtime manager's orphan sweep recomputes an
 * object's name from a live deployment it only knows by label. Keeping them
 * here (no runtime imports, no K8s client, no config) means those callers get
 * the real implementation instead of a hand-copied one.
 */

/**
 * Constructs the Kubernetes Secret name for an MCP server.
 *
 * Multi-tenant catalogs share a catalog-stable secret so all callers' pods
 * reference the same secret (env vars are catalog-level). Single-tenant
 * gets a per-mcpServer secret.
 */
export function constructK8sSecretName(
  mcpServerId: string,
  catalogItem?: InternalMcpCatalog | null,
  catalogId?: string | null,
): string {
  if (catalogItem?.multitenant && catalogId) {
    return `mcp-server-mt-${catalogId.slice(0, 8)}-secrets`;
  }
  return `mcp-server-${mcpServerId}-secrets`;
}

/**
 * Service name for a streamable-http deployment. Not just
 * `<deploymentName>-service`: the base is truncated/sanitized so the result
 * fits the 63-char RFC 1123 label limit (legacy deployment names can exceed
 * it).
 */
export function constructHttpServiceName(deploymentName: string): string {
  const maxBaseLength = MAX_K8S_LABEL_LENGTH - HTTP_SERVICE_SUFFIX.length;

  const base = deploymentName
    .replace(/\./g, "-")
    .slice(0, maxBaseLength)
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/g, "");

  const normalizedBase = base.length > 0 ? base : "mcp-server";
  return `${normalizedBase}${HTTP_SERVICE_SUFFIX}`;
}

const MAX_K8S_LABEL_LENGTH = 63;
const HTTP_SERVICE_SUFFIX = "-service";
