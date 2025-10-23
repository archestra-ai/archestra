import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_EMAIL_ENV_VAR_NAME,
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_PASSWORD_ENV_VAR_NAME,
} from "@shared";
import dotenv from "dotenv";
import packageJson from "../package.json";

/**
 * Load .env from platform root
 *
 * This is a bit of a hack for now to avoid having to have a duplicate .env file in the backend subdirectory
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env"), quiet: true });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const isProduction = ["production", "prod"].includes(
  process.env.NODE_ENV?.toLowerCase() ?? "",
);
const isDevelopment = !isProduction;

/**
 * Parse port from ARCHESTRA_API_BASE_URL if provided
 */
const getPortFromUrl = (): number => {
  const url = process.env.ARCHESTRA_API_BASE_URL;
  const defaultPort = 9000;

  if (!url) {
    return defaultPort;
  }

  try {
    const parsedUrl = new URL(url);
    return parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : defaultPort;
  } catch {
    return defaultPort;
  }
};

const parseAllowedOrigins = (): string[] => {
  // Development: use empty array to signal "use defaults" (localhost regex)
  if (isDevelopment) {
    return [];
  }

  // ARCHESTRA_FRONTEND_URL if set
  const frontendUrl = process.env.ARCHESTRA_FRONTEND_URL?.trim();
  if (frontendUrl && frontendUrl !== "") {
    return [frontendUrl];
  }

  return [];
};

/**
 * Get CORS origin configuration for Fastify.
 * Returns RegExp for localhost (development) or string[] for specific origins.
 */
const getCorsOrigins = (): RegExp | boolean | string[] => {
  const origins = parseAllowedOrigins();

  // Default: allow localhost on any port for development
  if (origins.length === 0) {
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  }

  return origins;
};

/**
 * Get trusted origins for better-auth.
 * Returns wildcard patterns for localhost (development) or specific origins for production.
 */
const getTrustedOrigins = (): string[] | undefined => {
  const origins = parseAllowedOrigins();

  // Default: allow localhost wildcards for development
  if (origins.length === 0) {
    return [
      "http://localhost:*",
      "https://localhost:*",
      "http://127.0.0.1:*",
      "https://127.0.0.1:*",
    ];
  }

  return origins;
};

export default {
  baseURL: process.env.ARCHESTRA_FRONTEND_URL,
  api: {
    host: "0.0.0.0",
    port: getPortFromUrl(),
    name: "Archestra Platform API",
    version: packageJson.version,
    corsOrigins: getCorsOrigins(),
    authHeaderName: "X-Archestra-API-Key",
  },
  mcpGateway: {
    endpoint: "/mcp",
  },
  auth: {
    secret: process.env.ARCHESTRA_AUTH_SECRET,
    trustedOrigins: getTrustedOrigins(),
    adminDefaultEmail:
      process.env[DEFAULT_ADMIN_EMAIL_ENV_VAR_NAME] || DEFAULT_ADMIN_EMAIL,
    adminDefaultPassword:
      process.env[DEFAULT_ADMIN_PASSWORD_ENV_VAR_NAME] ||
      DEFAULT_ADMIN_PASSWORD,
    cookieDomain: process.env.ARCHESTRA_AUTH_COOKIE_DOMAIN,
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  features: {
    mcp_registry: process.env.FEATURES_MCP_REGISTRY_ENABLED === "true",
  },
  debug: isDevelopment,
  production: isProduction,
  benchmark: {
    mockMode: process.env.BENCHMARK_MOCK_MODE === "true",
  },
};
