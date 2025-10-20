import { env } from "next-runtime-env";

/**
 * Get the display proxy URL for showing to users.
 * This is the URL that external agents should use to connect to Archestra.
 */
export const getDisplayProxyUrl = (): string => {
  const proxyUrlSuffix = "/v1";
  const baseUrl = env("NEXT_PUBLIC_ARCHESTRA_API_BASE_URL");

  if (!baseUrl) {
    return `http://localhost:9000${proxyUrlSuffix}`;
  } else if (baseUrl.endsWith(proxyUrlSuffix)) {
    return baseUrl;
  } else if (baseUrl.endsWith("/")) {
    return `${baseUrl.slice(0, -1)}${proxyUrlSuffix}`;
  }
  return `${baseUrl}${proxyUrlSuffix}`;
};

/**
 * Configuration object for the frontend application.
 */
export default {
  api: {
    /**
     * Display URL for showing to users (absolute URL for external agents).
     */
    displayProxyUrl: getDisplayProxyUrl(),
    /**
     * Base URL for frontend requests (empty to use relative URLs with Next.js rewrites).
     */
    baseUrl: "",
  },
  debug: process.env.NODE_ENV !== "production",
};
