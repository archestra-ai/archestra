import type { SupportedProvider } from "@archestra/shared";
import { getAppVersion } from "@/app-version";
import config from "@/config";
import logger from "@/logging";
import { SiteModel } from "@/models";
import { systemKeyManager } from "@/services/system-key-manager";
import type { Site, SiteCapabilities } from "@/types";

/**
 * The `sites` registry: this site's own row (written on startup, refreshed on
 * a heartbeat) and a short-lived cache of every site's row for routing. See
 * `sites/README.md`.
 */

const SITE_HEARTBEAT_INTERVAL_MS = 15_000;
/** A site whose heartbeat is older than this is treated as down. */
const SITE_STALE_AFTER_MS = 45_000;
/** How long a process trusts its copy of the sites table. */
const SITES_CACHE_TTL_MS = 5_000;

let heartbeat: NodeJS.Timeout | undefined;
let cache: { at: number; sites: Map<string, Site> } | undefined;

/** The name every routing decision compares against. */
export function currentSiteName(): string {
  return config.site.name;
}

/**
 * Whether this site can call a provider with this key. A system key is
 * keyless (Vertex AI or Bedrock through the cloud identity of the
 * environment), so it works only on sites whose environment enables that
 * provider; a key with a stored secret works on any site.
 */
export function canCallHere(key: {
  isSystem: boolean;
  provider: SupportedProvider;
}): boolean {
  return (
    !key.isSystem ||
    systemKeyManager.getEnabledProviders().includes(key.provider)
  );
}

/** What this site can reach, from its own environment. */
function detectCapabilities(): SiteCapabilities {
  return { keylessProviders: systemKeyManager.getEnabledProviders() };
}

/** Write this site's row and start its heartbeat. */
export async function registerSite(): Promise<Site> {
  const site = await SiteModel.upsert({
    name: config.site.name,
    role: config.site.role,
    internalUrl: config.site.internalUrl,
    version: getAppVersion(),
    capabilities: detectCapabilities(),
  });
  logger.info(
    {
      site: site.name,
      role: site.role,
      internalUrl: site.internalUrl,
      capabilities: site.capabilities,
    },
    "Registered this site",
  );
  startHeartbeat();
  return site;
}

/** Every site's row, at most a few seconds old. */
export async function listSites(): Promise<Map<string, Site>> {
  if (cache && Date.now() - cache.at < SITES_CACHE_TTL_MS) return cache.sites;
  const sites = new Map(
    (await SiteModel.findAll()).map((site) => [site.name, site]),
  );
  cache = { at: Date.now(), sites };
  return sites;
}

/** @public — tests that change the sites table */
export function clearSitesCache(): void {
  cache = undefined;
}

/** Why a site can't take work over the channel right now, or null when it can. */
export function siteUnavailableReason(
  site: Site | undefined,
  now = Date.now(),
): string | null {
  if (!site) return "is not registered";
  if (site.draining) return "is draining";
  if (!site.internalUrl)
    return "has no internal URL (ARCHESTRA_SITE_INTERNAL_URL)";
  if (now - site.lastSeenAt.getTime() > SITE_STALE_AFTER_MS)
    return `has not sent a heartbeat since ${site.lastSeenAt.toISOString()}`;
  return null;
}

// === Internal helpers ===

function startHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    void beat();
  }, SITE_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
}

async function beat(): Promise<void> {
  try {
    // An admin removed the row (a decommissioned site's name reused, or a
    // cleanup): write it again rather than disappear from routing.
    if (!(await SiteModel.heartbeat(config.site.name))) await registerSite();
  } catch (error) {
    logger.warn(
      { err: error, site: config.site.name },
      "Site heartbeat failed",
    );
  }
}
