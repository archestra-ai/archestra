/**
 * The names the MCP server deployments get in Kubernetes, without the
 * Kubernetes client: the models store and look up these names, and the runtime
 * deploys under them.
 */

/**
 * Ensures a string is RFC 1123 compliant for Kubernetes DNS subdomain names and label values.
 *
 * According to RFC 1123, Kubernetes DNS subdomain names must:
 * - contain no more than 253 characters
 * - contain only lowercase alphanumeric characters, '-' or '.'
 * - start with an alphanumeric character
 * - end with an alphanumeric character
 */
export function ensureStringIsRfc1123Compliant(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/-+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
}

/**
 * Frozen K8s deployment name for a NEW local (single-tenant) MCP server
 * install: `mcp-<slug40>-<id8>`. The id suffix makes new names structurally
 * unique (no collision handling needed); the slug keeps `kubectl` output
 * readable. Max 53 chars, so the derived `<name>-service` Service still fits
 * the 63-char RFC 1123 label limit. Computed once at creation, stored on the
 * `mcp_server` row, and never recomputed — deployment identity must not
 * follow the mutable display name, or renames orphan the running deployment.
 */
export function constructFrozenMcpDeploymentName(
  name: string,
  id: string,
): string {
  const slug =
    ensureStringIsRfc1123Compliant(name)
      .slice(0, 40)
      .replace(/[^a-z0-9]+$/, "") || "server";
  return `mcp-${slug}-${id.slice(0, 8)}`;
}

/**
 * Legacy single-tenant deployment name (`mcp-<slug>`), historically
 * recomputed from the mutable server name on every deploy. Kept only for
 * rows created before `deployment_name` existed: the startup adopt pass and
 * the rename cascade's freeze-fallback use it to freeze a byte-identical
 * value, and the runtime falls back to it while a row is still unfrozen.
 * New installs use {@link constructFrozenMcpDeploymentName} instead.
 */
export function constructLegacyMcpDeploymentName(name: string): string {
  return `mcp-${ensureStringIsRfc1123Compliant(name)}`.substring(0, 253);
}

/**
 * Shared-deployment name for a multitenant catalog:
 * `mcp-mt-<catalogId8>-<slug>`. New multitenant catalogs freeze exactly this
 * shape at creation — byte-identical to what the runtime historically
 * recomputed from the mutable catalog name — so existing deployments never
 * churn. The runtime also uses it as the recompute fallback for rows the
 * startup adopt pass hasn't frozen yet.
 */
export function constructLegacyMultitenantMcpDeploymentName(
  catalogId: string,
  name: string,
): string {
  const slugified = ensureStringIsRfc1123Compliant(name);
  return `mcp-mt-${catalogId.slice(0, 8)}-${slugified}`.substring(0, 253);
}
