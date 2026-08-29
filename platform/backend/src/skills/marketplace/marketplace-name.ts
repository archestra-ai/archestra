import { DEFAULT_APP_NAME } from "@archestra/shared";
import { OrganizationModel } from "@/models";
import type { Organization } from "@/types";

/** What a generated marketplace carries, which the derived name records. */
type MarketplaceKind = "skills" | "plugins" | "extensions";

/**
 * Deterministic marketplace name for an organization. Also used by the
 * connection-setup script endpoint, which creates share links at render time.
 *
 * The name is frozen at create time and registered in the user's local client
 * config under this exact name — changing it later would silently break every
 * installed marketplace, so we snapshot the current app+org branding now.
 *
 * Format: `<app-slug>-<org-slug>-<kind>`, e.g. `archestra-acme-corp-skills`.
 * Falls back to a hex slice of the org id if both slug and name are unusable.
 */
export async function deriveMarketplaceName(
  organizationId: string,
  kind: MarketplaceKind = "skills",
): Promise<string> {
  const org = await OrganizationModel.getById(organizationId);
  return marketplaceNameFor({ organizationId, organization: org, kind });
}

/**
 * Stable marketplace identity for a managed Bundle. Unlike ordinary share
 * links, a Bundle's marketplace name must survive changes to its membership,
 * including a transition between skills, native plugins, and local MCPs.
 */
export function bundleMarketplaceNameFor(params: {
  organizationId: string;
  bundleId: string;
  organization: Pick<Organization, "appName" | "slug" | "name"> | null;
}): string {
  const appSlug =
    slugify(params.organization?.appName ?? DEFAULT_APP_NAME) || "archestra";
  const orgSlug =
    slugify(params.organization?.slug ?? "") ||
    slugify(params.organization?.name ?? "") ||
    hexFallback(params.organizationId);
  // Keep the complete Bundle UUID as an intact suffix. Truncating the leading
  // branding is safe; truncating identity would let long org names collide.
  return capLengthWithSuffix(
    `${appSlug}-${orgSlug}`,
    `bundle-${params.bundleId.toLowerCase()}`,
  );
}

/**
 * Same derivation against an already-loaded organization row, for callers that
 * read it anyway (the static marketplace needs its display name too).
 */
export function marketplaceNameFor(params: {
  organizationId: string;
  organization: Pick<Organization, "appName" | "slug" | "name"> | null;
  kind?: MarketplaceKind;
}): string {
  const org = params.organization;
  const appSlug = slugify(org?.appName ?? DEFAULT_APP_NAME) || "archestra";
  const orgSlug =
    slugify(org?.slug ?? "") ||
    slugify(org?.name ?? "") ||
    hexFallback(params.organizationId);
  return capLength(`${appSlug}-${orgSlug}-${params.kind ?? "skills"}`);
}

/** Which kind a share link's contents make it. */
export function marketplaceKind(params: {
  skillIds: string[];
  pluginIds: string[];
}): MarketplaceKind {
  if (params.skillIds.length === 0) return "plugins";
  if (params.pluginIds.length === 0) return "skills";
  return "extensions";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hexFallback(organizationId: string): string {
  const cleaned = organizationId.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  return cleaned.slice(0, 8) || "default0";
}

/** Shared Claude/Codex/Copilot plugin and marketplace name limit. */
function capLength(name: string): string {
  const MAX = 64;
  return name.length <= MAX ? name : name.slice(0, MAX).replace(/-+$/g, "");
}

function capLengthWithSuffix(prefix: string, suffix: string): string {
  const MAX = 64;
  if (suffix.length >= MAX) return suffix;
  const availablePrefixLength = MAX - suffix.length - 1;
  const trimmedPrefix = prefix
    .slice(0, availablePrefixLength)
    .replace(/-+$/g, "");
  return trimmedPrefix ? `${trimmedPrefix}-${suffix}` : suffix;
}
