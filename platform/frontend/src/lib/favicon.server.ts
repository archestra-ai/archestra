import { createHash } from "node:crypto";

import {
  DEFAULT_THEME_ID,
  type OrganizationTheme,
  OrganizationThemeSchema,
} from "@archestra/shared";
import { getBackendBaseUrl } from "@/lib/config/config";

const APPEARANCE_SETTINGS_PATH = "/api/organization/appearance-settings";
export const DEFAULT_FAVICON_PATH = "/default-favicon.ico";
const FAVICON_PATH = "/favicon.ico";
export const PNG_DATA_URI_PREFIX = "data:image/png;base64,";

export type DeploymentFavicon = {
  bytes: ArrayBuffer | null;
  href: string;
  version: string | null;
};

/** What a document's first paint needs from the appearance settings. */
type DeploymentAppearance = {
  favicon: DeploymentFavicon;
  /** The organization's theme, or null when unset or not recognised. */
  theme: OrganizationTheme | null;
};

/**
 * The deployment favicon for a document's `<head>`, without waiting on the
 * backend: the last answer this process saw, refreshed in the background once
 * it is older than {@link FAVICON_TTL_MS}. Only a process that has never
 * reached the backend waits, and then for at most {@link COLD_WAIT_MS}
 * before falling back to the default icon.
 *
 * The trade-off: after an appearance change, documents keep the previous
 * content-versioned href for up to the TTL (plus the one request that starts
 * the refresh). `/favicon.ico` itself always reads fresh (see
 * getDeploymentFavicon) and redirects an outdated `?v=` to the current asset.
 */
export function getCachedDeploymentAppearance(): Promise<DeploymentAppearance> {
  return deploymentFaviconCache.get();
}

/**
 * The `<html>` class for the organization's theme (`theme-<id>`, see
 * themes.css), so the server-rendered page paints in it. Without a known
 * theme it falls back to the default one, never to the unthemed (white)
 * `:root`. The client keeps applying later changes (useOrgTheme).
 */
export function themeClassName(theme: OrganizationTheme | null): string {
  return `theme-${theme ?? DEFAULT_THEME_ID}`;
}

/** Start the first read at server start, so the first document finds it. */
export function warmDeploymentFavicon(): void {
  void deploymentFaviconCache.refresh();
}

/**
 * Resolve the deployment favicon from the backend now. The stable,
 * content-versioned href lets the user agent retain the branded bitmap while
 * a frontend route is loading instead of temporarily reusing an origin
 * default. The answer also refreshes the document cache above.
 */
export async function getDeploymentFavicon(): Promise<DeploymentFavicon> {
  return (await deploymentFaviconCache.refresh()).favicon;
}

// ===

/** How long a document may reuse the favicon this process last read. */
const FAVICON_TTL_MS = 30_000;
/** How long the very first document of a cold process waits for the backend. */
const COLD_WAIT_MS = 200;
const DEPLOYMENT_APPEARANCE_CACHE_KEY = Symbol.for(
  "archestra.deploymentAppearanceCache",
);

class DeploymentFaviconCache {
  private value: { appearance: DeploymentAppearance; readAt: number } | null =
    null;
  private inFlight: Promise<DeploymentAppearance> | null = null;

  async get(): Promise<DeploymentAppearance> {
    if (this.value) {
      if (Date.now() - this.value.readAt >= FAVICON_TTL_MS) {
        void this.refresh();
      }
      return this.value.appearance;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<DeploymentAppearance>((resolve) => {
      timer = setTimeout(() => resolve(defaultAppearance()), COLD_WAIT_MS);
    });
    try {
      return await Promise.race([this.refresh(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read the backend once (concurrent callers share the request). A failed
   * read is not cached: it answers with the last good value, or the default,
   * and the next document tries again.
   */
  refresh(): Promise<DeploymentAppearance> {
    this.inFlight ??= readDeploymentAppearance()
      .then((appearance) => {
        this.value = { appearance, readAt: Date.now() };
        return appearance;
      })
      .catch(() => this.value?.appearance ?? defaultAppearance())
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

/**
 * One cache per server process, not per module instance. Next bundles
 * `instrumentation.ts` apart from the app's server code, so each loads its
 * own copy of this module: a module-level cache would let the startup warm-up
 * fill a copy no document reads, and every new process would then render its
 * first document with the default theme until the client corrected it.
 */
const processGlobal = globalThis as {
  [DEPLOYMENT_APPEARANCE_CACHE_KEY]?: DeploymentFaviconCache;
};
const deploymentFaviconCache =
  processGlobal[DEPLOYMENT_APPEARANCE_CACHE_KEY] ??
  new DeploymentFaviconCache();
processGlobal[DEPLOYMENT_APPEARANCE_CACHE_KEY] = deploymentFaviconCache;

/** Throws when the backend cannot answer, so the cache keeps its last value. */
async function readDeploymentAppearance(): Promise<DeploymentAppearance> {
  // Do not put this in Next's data cache: appearance mutations happen in the
  // backend, so the frontend cannot reliably invalidate a Next cache tag.
  // The backend already uses an invalidated process-local appearance cache;
  // the frontend's own short-lived copy is DeploymentFaviconCache above.
  const response = await fetch(
    new URL(APPEARANCE_SETTINGS_PATH, getServerBackendBaseUrl()),
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(`appearance settings: ${response.status}`);
  }

  const body = (await response.json()) as {
    favicon?: unknown;
    theme?: unknown;
  };
  const parsedTheme = OrganizationThemeSchema.safeParse(body.theme);
  return {
    favicon: parseFavicon(body.favicon),
    theme: parsedTheme.success ? parsedTheme.data : null,
  };
}

function parseFavicon(favicon: unknown): DeploymentFavicon {
  if (typeof favicon !== "string" || !favicon.startsWith(PNG_DATA_URI_PREFIX)) {
    return defaultFavicon();
  }

  const base64 = favicon.slice(PNG_DATA_URI_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return defaultFavicon();
  }

  const version = createHash("sha256")
    .update(favicon)
    .digest("hex")
    .slice(0, 16);
  return {
    bytes: Uint8Array.from(Buffer.from(base64, "base64")).buffer,
    href: `${FAVICON_PATH}?v=${version}`,
    version,
  };
}

function getServerBackendBaseUrl() {
  return process.env.ARCHESTRA_INTERNAL_API_BASE_URL || getBackendBaseUrl();
}

function defaultAppearance(): DeploymentAppearance {
  return { favicon: defaultFavicon(), theme: null };
}

function defaultFavicon(): DeploymentFavicon {
  return {
    bytes: null,
    href: DEFAULT_FAVICON_PATH,
    version: null,
  };
}
