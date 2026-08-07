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
 * Resolve the deployment favicon before rendering a document. The stable,
 * content-versioned href lets the user agent retain the branded bitmap while a
 * frontend route is loading instead of temporarily reusing an origin default.
 */
export async function getDeploymentFavicon(): Promise<DeploymentFavicon> {
  try {
    // Do not put this in Next's data cache: appearance mutations happen in the
    // backend, so the frontend cannot reliably invalidate a Next cache tag.
    // The backend already uses an invalidated process-local appearance cache,
    // while no-store ensures the very next document gets the new asset hash.
    const response = await fetch(
      new URL(APPEARANCE_SETTINGS_PATH, getServerBackendBaseUrl()),
      { cache: "no-store" },
    );
    if (!response.ok) return defaultFavicon();

    const { favicon } = (await response.json()) as { favicon?: unknown };
    if (
      typeof favicon !== "string" ||
      !favicon.startsWith(PNG_DATA_URI_PREFIX)
    ) {
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
  } catch {
    return defaultFavicon();
  }
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
