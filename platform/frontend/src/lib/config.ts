import { env } from "next-runtime-env";
import type { PostHogConfig } from "posthog-js";

const environment: "development" | "production" =
  (process.env.NODE_ENV?.toLowerCase() as "development" | "production") ??
  "development";

const DEFAULT_BACKEND_URL = "http://localhost:9000";

/**
 * Get the backend API base URL.
 * Returns the configured URL or defaults to localhost:9000 for development.
 *
 * Priority:
 * 1. NEXT_PUBLIC_ARCHESTRA_INTERNAL_API_BASE_URL (runtime env var for client/server)
 * 2. ARCHESTRA_INTERNAL_API_BASE_URL (server-side only, for SSR/API routes)
 * 3. Default: http://localhost:9000
 */
export const getBackendBaseUrl = (): string => {
  // Try runtime env var first (works in both client and server)
  const publicUrl = env("NEXT_PUBLIC_ARCHESTRA_INTERNAL_API_BASE_URL");
  if (publicUrl) {
    return publicUrl;
  }

  // Server-side only: try non-public env var (for API routes and SSR)
  if (
    typeof window === "undefined" &&
    process.env.ARCHESTRA_INTERNAL_API_BASE_URL
  ) {
    return process.env.ARCHESTRA_INTERNAL_API_BASE_URL;
  }

  return DEFAULT_BACKEND_URL;
};

/**
 * Get the internal proxy URL for in-cluster communication.
 * This is the URL that agents inside the cluster should use to connect to Archestra.
 * Uses getBackendBaseUrl() which reads from ARCHESTRA_INTERNAL_API_BASE_URL.
 */
export const getInternalProxyUrl = (): string => {
  const proxyUrlSuffix = "/v1";
  const baseUrl = getBackendBaseUrl();

  if (baseUrl.endsWith(proxyUrlSuffix)) {
    return baseUrl;
  } else if (baseUrl.endsWith("/")) {
    return `${baseUrl.slice(0, -1)}${proxyUrlSuffix}`;
  }
  return `${baseUrl}${proxyUrlSuffix}`;
};

/**
 * Helper to append /v1 suffix to a base URL.
 */
const appendProxySuffix = (baseUrl: string): string => {
  const proxyUrlSuffix = "/v1";
  if (baseUrl.endsWith(proxyUrlSuffix)) {
    return baseUrl;
  } else if (baseUrl.endsWith("/")) {
    return `${baseUrl.slice(0, -1)}${proxyUrlSuffix}`;
  }
  return `${baseUrl}${proxyUrlSuffix}`;
};

/**
 * Get all configured external proxy URLs (with /v1 suffix).
 * Supports comma-separated list in NEXT_PUBLIC_ARCHESTRA_API_BASE_URL.
 * Returns array of URLs for UI display when multiple URLs are configured.
 */
export const getExternalProxyUrls = (): string[] => {
  const externalUrl = env("NEXT_PUBLIC_ARCHESTRA_API_BASE_URL");
  if (!externalUrl) {
    return [];
  }
  return externalUrl
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0)
    .map(appendProxySuffix);
};

/**
 * Get the WebSocket URL for general communication.
 *
 * Client-side: Uses relative URL that goes through Next.js rewrite (see next.config.ts).
 * This ensures WebSocket works in all deployment scenarios without extra env vars.
 *
 * Server-side: Uses absolute URL derived from ARCHESTRA_INTERNAL_API_BASE_URL.
 */
export const getWebSocketUrl = (): string => {
  // Client-side: use relative URL (goes through Next.js rewrite)
  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws`;
  }

  // Server-side: use absolute URL
  const backendBaseUrl = getBackendBaseUrl();
  const wsBaseUrl = backendBaseUrl
    ? backendBaseUrl.replace(/^http/, "ws")
    : "ws://localhost:9000";
  return `${wsBaseUrl}/ws`;
};

/**
 * Configuration object for the frontend application.
 * Use process.env.NEXT_PUBLIC_xxxx to access build-time variables in build-time,
 * and env('NEXT_PUBLIC_xxxx') to access the runtime variables in runtime.
 *
 * For example, doing `enabled: env("NEXT_PUBLIC_ARCHESTRA_ANALYTICS")` results in `enabled: undefined`,
 * because the runtime variable isn't yet available in build-time.
 */
export default {
  api: {
    /**
     * All configured external proxy URLs for displaying connection options.
     * Returns array of URLs when multiple URLs are configured via comma-separated list.
     */
    get externalProxyUrls() {
      return getExternalProxyUrls();
    },
    /**
     * Internal URL for in-cluster communication.
     */
    get internalProxyUrl() {
      return getInternalProxyUrl();
    },
    /**
     * Base URL for frontend requests (empty to use relative URLs with Next.js rewrites).
     */
    baseUrl: "",
  },
  websocket: {
    /**
     * WebSocket URL for real-time communication
     */
    get url() {
      return getWebSocketUrl();
    },
  },
  debug: process.env.NODE_ENV !== "production",
  environment,
  posthog: {
    // Analytics is enabled by default, disabled only when explicitly set to "disabled"
    get enabled() {
      return env("NEXT_PUBLIC_ARCHESTRA_ANALYTICS") !== "disabled";
    },
    token: "phc_FFZO7LacnsvX2exKFWehLDAVaXLBfoBaJypdOuYoTk7",
    config: {
      api_host: "https://eu.i.posthog.com",
      person_profiles: "identified_only",
      session_recording: {
        recordHeaders: true,
        recordBody: true,
        maskCapturedNetworkRequestFn: (data) => {
          const sensitiveHeaders = ["authorization", "cookie", "set-cookie"];
          if (data.requestHeaders) {
            for (const header of sensitiveHeaders) {
              if (header in data.requestHeaders) {
                data.requestHeaders[header] = "***REDACTED***";
              }
            }
          }
          if (data.responseHeaders) {
            for (const header of sensitiveHeaders) {
              if (header in data.responseHeaders) {
                data.responseHeaders[header] = "***REDACTED***";
              }
            }
          }
          return data;
        },
      },
    } satisfies Partial<PostHogConfig>,
  },
  /**
   * Mark enterprise license status to hide Archestra-specific branding and UI sections when enabled.
   */
  get enterpriseLicenseActivated() {
    return env("NEXT_PUBLIC_ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED") === "true";
  },
  /**
   * When true, hides the username/password login form and requires SSO for authentication.
   */
  get disableBasicAuth() {
    return env("NEXT_PUBLIC_ARCHESTRA_AUTH_DISABLE_BASIC_AUTH") === "true";
  },
  /**
   * When true, hides invitation-related UI and blocks invitation API endpoints.
   */
  get disableInvitations() {
    return env("NEXT_PUBLIC_ARCHESTRA_AUTH_DISABLE_INVITATIONS") === "true";
  },
  sentry: {
    get dsn() {
      return env("NEXT_PUBLIC_ARCHESTRA_SENTRY_FRONTEND_DSN") || "";
    },
    get environment() {
      return (
        env("NEXT_PUBLIC_ARCHESTRA_SENTRY_ENVIRONMENT")?.toLowerCase() ||
        environment
      );
    },
  },
};
