import { isSupportedProvider, type SupportedProvider } from "@shared";

const DEFAULT_MCP_SERVER_SLUG = "archestra";

/**
 * Slugify the org's app name for use as an MCP server key (e.g. the key in
 * `mcpServers` or the CLI arg for `claude mcp add`). White-label deployments
 * rely on this — a user of "Acme AI" should see `acme-ai` in their config,
 * not `archestra`.
 */
export function toMcpServerSlug(appName: string): string {
  const slug = appName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || DEFAULT_MCP_SERVER_SLUG;
}

/**
 * Narrow `organization.connectionShownProviders` (typed as `string[] | null`
 * by the generated API client) to `SupportedProvider[] | null`, dropping any
 * provider IDs the frontend doesn't know about.
 */
export function getShownProviders(
  organization:
    | { connectionShownProviders?: readonly string[] | null }
    | null
    | undefined,
): SupportedProvider[] | null {
  const raw = organization?.connectionShownProviders;
  if (!raw) return null;
  return raw.filter(isSupportedProvider);
}

/**
 * Resolve which ID to use for a Connection-page slot (MCP gateway or LLM proxy).
 *
 * Priority: user selection → URL param → admin default → system default → first available.
 *
 * `skipAdminDefault` lets callers bypass the admin default when the user
 * arrived from the opposite slot's table (e.g. picked a specific LLM proxy),
 * so a pre-configured default on this side doesn't override their intent.
 */
export function resolveEffectiveId(params: {
  selected: string | null;
  fromUrl: string | null;
  adminDefault: string | null | undefined;
  systemDefault: string | null | undefined;
  firstAvailable: string | null | undefined;
  skipAdminDefault: boolean;
}): string | null {
  const {
    selected,
    fromUrl,
    adminDefault,
    systemDefault,
    firstAvailable,
    skipAdminDefault,
  } = params;
  return (
    selected ??
    fromUrl ??
    (skipAdminDefault ? null : adminDefault) ??
    systemDefault ??
    firstAvailable ??
    null
  );
}
