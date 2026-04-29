import {
  type archestraApiTypes,
  isSupportedProvider,
  type SupportedProvider,
} from "@shared";

const DEFAULT_MCP_SERVER_SLUG = "archestra";

export type ConnectionBaseUrl = NonNullable<
  archestraApiTypes.GetOrganizationResponses["200"]["connectionBaseUrls"]
>[number];

/**
 * Pick the env URLs end users should see on /connection. Admins can hide
 * individual env URLs via `connectionBaseUrls` metadata; we filter those out.
 * If everything is hidden (or env has none), fall back to the in-cluster
 * internal URL so the page never renders an empty selector.
 */
export function resolveCandidateBaseUrls(params: {
  externalProxyUrls: readonly string[];
  internalProxyUrl: string;
  metadata: readonly ConnectionBaseUrl[] | null | undefined;
}): string[] {
  const { externalProxyUrls, internalProxyUrl, metadata } = params;
  const hidden = new Set(
    (metadata ?? []).filter((m) => m.visible === false).map((m) => m.url),
  );
  const visibleExternal = externalProxyUrls.filter((url) => !hidden.has(url));
  return visibleExternal.length > 0 ? visibleExternal : [internalProxyUrl];
}

export function resolveAdminDefaultBaseUrl(
  metadata: readonly ConnectionBaseUrl[] | null | undefined,
): string | null {
  return metadata?.find((m) => m.isDefault)?.url ?? null;
}

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
/**
 * Decide which client to pre-select on the `/connection` page.
 *
 * Priority: URL param (`?clientId=`) → admin default. If neither is set, no
 * client is pre-selected. Candidates that aren't in the visible set are
 * skipped so we never select a tile the user can't see.
 */
export function resolveInitialClientId(params: {
  urlClientId: string | null;
  adminDefaultClientId: string | null | undefined;
  visibleClientIds: readonly string[];
}): string | null {
  const { urlClientId, adminDefaultClientId, visibleClientIds } = params;
  const visible = new Set(visibleClientIds);
  const pick = (id: string | null | undefined): string | null =>
    id && visible.has(id) ? id : null;
  return pick(urlClientId) ?? pick(adminDefaultClientId);
}

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
