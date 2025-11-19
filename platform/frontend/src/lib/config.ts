import { env } from "next-runtime-env";
import type { PostHogConfig } from "posthog-js";

const environment = process.env.NODE_ENV?.toLowerCase() ?? "";

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
  posthog: {
    // Analytics is enabled by default, disabled only when explicitly set to "disabled"
    enabled: env("NEXT_PUBLIC_ARCHESTRA_ANALYTICS") !== "disabled",
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
    baseMcpServerDockerImage:
      env("NEXT_PUBLIC_ARCHESTRA_ORCHESTRATOR_MCP_SERVER_BASE_IMAGE") ||
      "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-base:0.0.3",
  },
  features: {
    /**
     * Enable team-based authentication/installation for MCP servers.
     * Disabled by default.
     */
    enableTeamAuth: env("NEXT_PUBLIC_ARCHESTRA_ENABLE_TEAM_AUTH") === "true",
  },
  /**
   * Hide Archestra-specific branding and UI sections when enabled.
   */
  hideArchestraBranding: env("NEXT_PUBLIC_ARCHESTRA_HIDE_BRANDING") === "true",
  sentry: {
    dsn: env("NEXT_PUBLIC_ARCHESTRA_SENTRY_FRONTEND_DSN") || "",
    environment:
      env("NEXT_PUBLIC_ARCHESTRA_SENTRY_ENVIRONMENT")?.toLowerCase() ||
      environment,
  },
};
