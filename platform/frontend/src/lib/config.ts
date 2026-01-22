import { env } from "next-runtime-env";
import type { PostHogConfig } from "posthog-js";

const environment = process.env.NODE_ENV?.toLowerCase() ?? "";

const DEFAULT_BACKEND_URL = "http://localhost:9000";

/**
 * Get the backend API base URL.
 * Returns the configured URL or defaults to localhost:9000 for development.
 *
 * Priority:
 * 1. NEXT_PUBLIC_ARCHESTRA_API_BASE_URL (runtime env var for client/server)
 * 2. ARCHESTRA_API_BASE_URL (server-side only, for SSR/API routes)
 * 3. Default: http://localhost:9000
 */
export const getBackendBaseUrl = (): string => {
  // Try runtime env var first (works in both client and server)
  const publicUrl = env("NEXT_PUBLIC_ARCHESTRA_API_BASE_URL");
  if (publicUrl) {
    return publicUrl;
  }

  // Server-side only: try non-public env var (for API routes and SSR)
  if (typeof window === "undefined" && process.env.ARCHESTRA_API_BASE_URL) {
    return process.env.ARCHESTRA_API_BASE_URL;
  }

  return DEFAULT_BACKEND_URL;
};

/**
 * Priority:
 * 1. NEXT_PUBLIC_ARCHESTRA_API_EXTERNAL_BASE_URL (explicit external URL)
 * 2. Falls back to getBackendBaseUrl() for backwards compatibility
 *
 * Exported for testing purposes.
 */
export const _getExternalBaseUrl = (): string => {
  const externalUrl = env("NEXT_PUBLIC_ARCHESTRA_API_EXTERNAL_BASE_URL");
  if (externalUrl) {
    return externalUrl;
  }
  return getBackendBaseUrl();
};

/**
 * Get the internal proxy URL for in-cluster communication.
 * This is the URL that agents inside the cluster should use to connect to Archestra.
 * Uses getBackendBaseUrl() which reads from ARCHESTRA_API_BASE_URL.
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
 * Get the display proxy URL for showing to users.
 */
export const getExternalProxyUrl = (): string => {
  const proxyUrlSuffix = "/v1";
  const baseUrl = _getExternalBaseUrl();

  if (baseUrl.endsWith(proxyUrlSuffix)) {
    return baseUrl;
  } else if (baseUrl.endsWith("/")) {
    return `${baseUrl.slice(0, -1)}${proxyUrlSuffix}`;
  }
  return `${baseUrl}${proxyUrlSuffix}`;
};

/**
 * Get the WebSocket URL for general communication.
 *
 * Client-side: Uses relative URL that goes through Next.js rewrite (see next.config.ts).
 * This ensures WebSocket works in all deployment scenarios without extra env vars.
 *
 * Server-side: Uses absolute URL derived from ARCHESTRA_API_BASE_URL.
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
     * Display URL for showing to users (absolute URL for external agents).
     */
    get externalProxyUrl() {
      return getExternalProxyUrl();
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
  posthog: {
    // Analytics is enabled by default, disabled only when explicitly set to "disabled"
    get enabled() {
      return env("NEXT_PUBLIC_ARCHESTRA_ANALYTICS") !== "disabled";
    },
    token: "phc_FFZO7LacnsvX2exKFWehLDAVaXLBfoBaJypdOuYoTk7",
    config: {
      api_host: "https://eu.i.posthog.com",
      person_profiles: "identified_only",
    } satisfies Partial<PostHogConfig>,
  },
  orchestrator: {
    /**
     * Base Docker image used for MCP servers (shown in UI for reference).
     */
    get baseMcpServerDockerImage() {
      return (
        env("NEXT_PUBLIC_ARCHESTRA_ORCHESTRATOR_MCP_SERVER_BASE_IMAGE") ||
        "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-base:0.0.3"
      );
    },
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
