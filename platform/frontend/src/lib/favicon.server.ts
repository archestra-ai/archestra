import { createHash } from "node:crypto";

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
export function getCachedDeploymentFavicon(): Promise<DeploymentFavicon> {
  return deploymentFaviconCache.get();
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
  return deploymentFaviconCache.refresh();
}

// ===

/** How long a document may reuse the favicon this process last read. */
const FAVICON_TTL_MS = 30_000;
/** How long the very first document of a cold process waits for the backend. */
const COLD_WAIT_MS = 200;

class DeploymentFaviconCache {
  private value: { favicon: DeploymentFavicon; readAt: number } | null = null;
  private inFlight: Promise<DeploymentFavicon> | null = null;

  async get(): Promise<DeploymentFavicon> {
    if (this.value) {
      if (Date.now() - this.value.readAt >= FAVICON_TTL_MS) {
        void this.refresh();
      }
      return this.value.favicon;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<DeploymentFavicon>((resolve) => {
      timer = setTimeout(() => resolve(defaultFavicon()), COLD_WAIT_MS);
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
  refresh(): Promise<DeploymentFavicon> {
    this.inFlight ??= readDeploymentFavicon()
      .then((favicon) => {
        this.value = { favicon, readAt: Date.now() };
        return favicon;
      })
      .catch(() => this.value?.favicon ?? defaultFavicon())
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

const deploymentFaviconCache = new DeploymentFaviconCache();

/** Throws when the backend cannot answer, so the cache keeps its last value. */
async function readDeploymentFavicon(): Promise<DeploymentFavicon> {
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

  const { favicon } = (await response.json()) as { favicon?: unknown };
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

function defaultFavicon(): DeploymentFavicon {
  return {
    bytes: null,
    href: DEFAULT_FAVICON_PATH,
    version: null,
  };
}
