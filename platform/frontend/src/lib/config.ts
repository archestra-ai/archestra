import { env } from "next-runtime-env";
import type { PostHogConfig } from "posthog-js";

const environment = process.env.NODE_ENV?.toLowerCase() ?? "";

const getBackendBaseUrl = (): string | undefined =>
  env("NEXT_PUBLIC_ARCHESTRA_API_BASE_URL");

/**
 * Get the display proxy URL for showing to users.
 * This is the URL that external agents should use to connect to Archestra.
 */
export const getDisplayProxyUrl = (): string => {
  const proxyUrlSuffix = "/v1";
  const backendBaseUrl = getBackendBaseUrl();

  if (!backendBaseUrl) {
    return `http://localhost:9000${proxyUrlSuffix}`;
  } else if (backendBaseUrl.endsWith(proxyUrlSuffix)) {
    return backendBaseUrl;
  } else if (backendBaseUrl.endsWith("/")) {
    return `${backendBaseUrl.slice(0, -1)}${proxyUrlSuffix}`;
  }
  return `${backendBaseUrl}${proxyUrlSuffix}`;
};

/**
 * Get the WebSocket URL
 */
const getWebSocketUrl = (): string => {
  const backendBaseUrl = getBackendBaseUrl();

  // In development, use localhost
  if (!backendBaseUrl || typeof window === "undefined") {
    return "ws://localhost:9000/ws";
  }

  // Convert http(s) to ws(s)
  const wsUrl = backendBaseUrl.replace(/^http/, "ws");
  return `${wsUrl}/ws`;
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
    return env("NEXT_PUBLIC_ARCHESTRA_DISABLE_BASIC_AUTH") === "true";
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
