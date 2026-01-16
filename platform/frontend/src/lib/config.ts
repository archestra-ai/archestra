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
 * Get the external base URL for displaying connection instructions to users.
 * This is the URL that external agents should use to connect to Archestra from outside the cluster.
 *
 * Priority:
 * 1. NEXT_PUBLIC_ARCHESTRA_API_EXTERNAL_BASE_URL (explicit external URL)
 * 2. Falls back to getBackendBaseUrl() for backwards compatibility
 */
export const getExternalBaseUrl = (): string => {
  const externalUrl = env("NEXT_PUBLIC_ARCHESTRA_API_EXTERNAL_BASE_URL");
  if (externalUrl) {
    return externalUrl;
  }
  return getBackendBaseUrl();
};

/**
 * Get the display proxy URL for showing to users.
 * This is the URL that external agents should use to connect to Archestra.
 * Uses getExternalBaseUrl() to support separate internal/external URLs in K8s deployments.
 */
export const getDisplayProxyUrl = (): string => {
  const proxyUrlSuffix = "/v1";
  const baseUrl = getExternalBaseUrl();

  if (baseUrl.endsWith(proxyUrlSuffix)) {
    return baseUrl;
  } else if (baseUrl.endsWith("/")) {
    return `${baseUrl.slice(0, -1)}${proxyUrlSuffix}`;
  }
  return `${baseUrl}${proxyUrlSuffix}`;
};

/**
 * Get the WebSocket base URL (without path)
 */
const getWebSocketBaseUrl = (): string => {
  const backendBaseUrl = getBackendBaseUrl();

  // In development, use localhost
  if (!backendBaseUrl || typeof window === "undefined") {
    return "ws://localhost:9000";
  }

  // Convert http(s) to ws(s)
  return backendBaseUrl.replace(/^http/, "ws");
};

/**
 * Get the WebSocket URL for general communication
 */
export const getWebSocketUrl = (): string => {
  return `${getWebSocketBaseUrl()}/ws`;
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
    get displayProxyUrl() {
      return getDisplayProxyUrl();
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
